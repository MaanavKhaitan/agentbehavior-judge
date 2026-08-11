#!/usr/bin/env node
// Aggregate repeated calibration runs into presentable statistics.
//
// Accepts any mix of:
//   - `behavior-judge calibrate --json` output (one run per file), and
//   - `scripts/upstream-calibrate.mjs --json` output (an array of runs per file),
// and reports, across all runs: mean per-run agreement with a 95% confidence
// interval, perfect-run counts, pooled per-verdict accuracy (Wilson interval),
// run-to-run verdict consistency, and a per-case miss breakdown that separates
// wrong verdicts from hard judge errors.
//
// Usage:
//   node scripts/agreement-stats.mjs [--label <name>] [--convention-cases <id,id>] <run.json ...>
//
// --convention-cases marks trajectory ids whose expected labels hinge on a
// judging convention (e.g. incomplete-trace NA discipline); their misses are
// tallied separately so convention gaps are not conflated with clear errors.

import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";

// Two-sided 95% t quantiles by degrees of freedom (fallback 1.96).
const T_95 = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  14: 2.145,
  19: 2.093,
  29: 2.045,
};

function tQuantile(df) {
  if (df <= 0) return Number.NaN;
  if (T_95[df] !== undefined) return T_95[df];
  const keys = Object.keys(T_95)
    .map(Number)
    .sort((a, b) => a - b);
  for (const key of keys) if (df <= key) return T_95[key];
  return 1.96;
}

function wilson95(successes, total) {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (p + z ** 2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z ** 2 / (4 * total ** 2))) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function percent(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}

async function loadRuns(files) {
  const runs = [];
  for (const file of files) {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (Array.isArray(parsed)) {
      for (const run of parsed) {
        if (!Array.isArray(run?.comparisons)) {
          throw new Error(`${file}: array entries must have a comparisons array.`);
        }
        runs.push(run.comparisons);
      }
    } else if (Array.isArray(parsed?.comparisons)) {
      runs.push(parsed.comparisons);
    } else {
      throw new Error(`${file}: not a calibrate --json or upstream-calibrate --json output.`);
    }
  }
  return runs;
}

function main(runs, conventionCases, label) {
  const n = runs.length;
  if (n === 0) throw new Error("No runs found.");

  const perRunMeta = [];
  const perRunFile = [];
  let perfectRuns = 0;
  // (case|meta) -> { verdicts: Set, misses: number, errors: number, expected }
  const slots = new Map();
  const fileSlots = new Map();

  for (const comparisons of runs) {
    let metaAgreed = 0;
    let metaTotal = 0;
    let fileAgreed = 0;
    for (const comparison of comparisons) {
      const fileKey = comparison.trajectoryId;
      const fileSlot = fileSlots.get(fileKey) ?? { verdicts: new Set(), misses: 0 };
      fileSlot.verdicts.add(comparison.fileActual);
      if (!comparison.fileMatch) fileSlot.misses += 1;
      else fileAgreed += 1;
      fileSlots.set(fileKey, fileSlot);

      for (const meta of comparison.metaComparisons) {
        metaTotal += 1;
        const key = `${comparison.trajectoryId} :: ${meta.name}`;
        const slot = slots.get(key) ?? {
          verdicts: new Set(),
          misses: 0,
          errors: 0,
          expected: meta.expected,
        };
        slot.verdicts.add(meta.actual);
        if (meta.match) metaAgreed += 1;
        else if (meta.actual === "error") slot.errors += 1;
        else slot.misses += 1;
        slots.set(key, slot);
      }
    }
    perRunMeta.push(metaAgreed / metaTotal);
    perRunFile.push(fileAgreed / comparisons.length);
    if (metaAgreed === metaTotal && fileAgreed === comparisons.length) perfectRuns += 1;
  }

  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const metaMean = mean(perRunMeta);
  const fileMean = mean(perRunFile);
  const sd = (values, mu) =>
    values.length < 2
      ? 0
      : Math.sqrt(values.reduce((sum, value) => sum + (value - mu) ** 2, 0) / (values.length - 1));
  const metaSd = sd(perRunMeta, metaMean);
  const halfWidth = n < 2 ? 0 : (tQuantile(n - 1) * metaSd) / Math.sqrt(n);

  const slotCount = slots.size;
  const pooledTotal = slotCount * n;
  const pooledAgreed = Math.round(metaMean * pooledTotal);
  const pooled = wilson95(pooledAgreed, pooledTotal);

  const unanimous = [...slots.values()].filter((slot) => slot.verdicts.size === 1).length;
  const fileUnanimous = [...fileSlots.values()].filter((slot) => slot.verdicts.size === 1).length;

  const missedSlots = [...slots.entries()].filter(([, slot]) => slot.misses + slot.errors > 0);
  const conventionMisses = missedSlots.filter(([key]) =>
    conventionCases.some((caseId) => key.startsWith(`${caseId} ::`)),
  );

  const lines = [];
  lines.push(`=== ${label} (${n} runs, ${slotCount} meta-verdict slots per run) ===`);
  lines.push(
    `per-run meta agreement: mean ${percent(metaMean)} ± ${percent(halfWidth)} (95% CI over runs), min ${percent(Math.min(...perRunMeta))}, max ${percent(Math.max(...perRunMeta))}`,
  );
  lines.push(
    `pooled meta-verdict accuracy: ${pooledAgreed}/${pooledTotal} = ${percent(metaMean)} (Wilson 95% CI ${percent(pooled.low)}–${percent(pooled.high)})`,
  );
  lines.push(`per-run file agreement: mean ${percent(fileMean)}`);
  lines.push(`perfect runs (all meta + file verdicts correct): ${perfectRuns}/${n}`);
  lines.push(
    `verdict consistency: ${unanimous}/${slotCount} meta slots and ${fileUnanimous}/${fileSlots.size} file verdicts unanimous across all runs`,
  );
  if (missedSlots.length === 0) {
    lines.push("misses: none");
  } else {
    lines.push(
      `missed slots: ${missedSlots.length}/${slotCount} (${conventionMisses.length} in convention-dependent cases [${conventionCases.join(", ") || "none marked"}], ${missedSlots.length - conventionMisses.length} elsewhere)`,
    );
    for (const [key, slot] of missedSlots.sort(
      (a, b) => b[1].misses + b[1].errors - (a[1].misses + a[1].errors),
    )) {
      const parts = [];
      if (slot.misses > 0) parts.push(`wrong verdict in ${slot.misses}/${n} runs`);
      if (slot.errors > 0) parts.push(`judge error in ${slot.errors}/${n} runs`);
      lines.push(
        `  ${key} (expected ${slot.expected}): ${parts.join(", ")} [saw: ${[...slot.verdicts].join(", ")}]`,
      );
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    label: { type: "string" },
    "convention-cases": { type: "string" },
  },
});
if (positionals.length === 0) {
  process.stderr.write(
    "Usage: node scripts/agreement-stats.mjs [--label <name>] [--convention-cases <id,id>] <run.json ...>\n",
  );
  process.exit(1);
}
const conventionCases = (values["convention-cases"] ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
main(await loadRuns(positionals), conventionCases, values.label ?? "runs");
