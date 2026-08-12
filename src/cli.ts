#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";

import { applyNearestDotEnv } from "./env.js";
import { runInterview } from "./generate.js";
import { runWebInterview } from "./webInterview.js";
import { completeWithBraintrustGateway, type JudgeCompletion } from "./gateway.js";
import {
  compareToExpected,
  judgeTrajectory,
  type ClauseResult,
  type JudgmentComparison,
  type TrajectoryJudgment,
} from "./judge.js";
import { parseIr, serializeIr, type JudgeIr } from "./ir.js";
import { loadBehaviorSpec, type BehaviorSpec } from "./spec.js";
import { loadTrajectoryFile, type TrajectoryCase } from "./trajectory.js";

export interface CliDeps {
  complete?: JudgeCompletion;
  ask?: (question: string, prefill?: string) => Promise<string>;
  /**
   * Replaces the default nearest-`.env` loading; tests stub it so the real
   * workspace `.env` never leaks into `process.env`.
   */
  loadEnv?: () => Promise<void>;
  /** Replaces the platform browser opener for `generate --web`; tests use it to reach the URL. */
  openBrowser?: (url: string) => void;
}

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  json: boolean;
  help: boolean;
  version: boolean;
  out: string | undefined;
  model: string | undefined;
  noVerify: boolean;
  web: boolean;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const { positionals, values } = parseNodeArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      out: { type: "string" },
      model: { type: "string" },
      "no-verify": { type: "boolean" },
      web: { type: "boolean" },
    },
  });

  return {
    command: positionals[0],
    positionals: positionals.slice(1),
    json: values.json ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
    out: values.out,
    model: values.model,
    noVerify: values["no-verify"] ?? false,
    web: values.web ?? false,
  };
}

function usage(): string {
  return `behavior-judge compiles Agent Behavior specs into judge IRs and runs them over trajectories.

Usage:
  behavior-judge generate  <behavior-path> <trajectory.json ...> [--out <file>] [--model <m>] [--web]
  behavior-judge judge     <ir.yaml> <trajectory.json ...> [--json] [--model <m>] [--no-verify]
  behavior-judge calibrate <ir.yaml> <trajectory.json ...> [--json] [--model <m>] [--no-verify]

generate interviews you through compiling a BEHAVIOR.md into a judge.yaml IR,
binding deterministic checks to the event vocabulary observed in the sample
trajectories. With --web the same interview runs in your browser on a
local-only server (127.0.0.1, one-time token); the terminal prints the URL
and still writes the file. judge runs an IR over trajectory JSON files.
calibrate compares judge verdicts against expected verdicts recorded in the
trajectory files.

Trajectory JSON files contain a trajectory ({id, complete, events}), a
{trajectory, expected} wrapper, or an array of either.

LLM calls go through the Braintrust Gateway (BRAINTRUST_API_KEY,
BRAINTRUST_MODEL, BRAINTRUST_GATEWAY_BASE_URL). Variables not already set in
the environment are read from the nearest .env file at or above the working
directory. Without an API key, judge runs predicates only: semantic checks
report na and predicate failures stay unverified.
`;
}

async function packageVersion(): Promise<string> {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(await fs.readFile(packageJsonUrl, "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function loadIrFile(irPath: string): Promise<JudgeIr> {
  const content = await fs.readFile(irPath, "utf8");
  return parseIr(content);
}

async function loadCases(files: string[]): Promise<TrajectoryCase[]> {
  const loaded = await Promise.all(files.map((file) => loadTrajectoryFile(file)));
  return loaded.flat();
}

function verdictLabel(verdict: string, naReason: string | null): string {
  return verdict === "na" && naReason !== null ? `na(${naReason})` : verdict;
}

function clauseLine(clause: ClauseResult): string {
  const citations =
    clause.citations.length > 0
      ? ` [${clause.citations.map((citation) => citation.eventId).join(", ")}]`
      : "";
  let verification = "";
  if (clause.verification === "unverified") verification = " (unverified)";
  if (clause.verification === "confirmed") verification = " (verifier confirmed)";
  if (clause.verification === "overturned") {
    verification = " (predicate flagged false, verifier overturned)";
  }
  return `    ${clause.kind} "${clause.quote}": ${verdictLabel(clause.verdict, clause.naReason)}${citations}${verification}`;
}

function formatJudgment(judgment: TrajectoryJudgment): string {
  const lines = [`${judgment.trajectoryId}: ${judgment.verdict}`];
  for (const meta of judgment.metaBehaviors) {
    lines.push(`  ${meta.name}: ${verdictLabel(meta.verdict, meta.naReason)}`);
    for (const clause of meta.clauses) {
      lines.push(clauseLine(clause));
    }
  }
  return lines.join("\n");
}

function formatComparison(comparison: JudgmentComparison): string {
  const mark = (match: boolean) => (match ? "ok" : "MISMATCH");
  const lines = [
    `${comparison.trajectoryId}: file expected ${comparison.fileExpected}, got ${comparison.fileActual} — ${mark(comparison.fileMatch)}`,
  ];
  for (const meta of comparison.metaComparisons) {
    lines.push(
      `  ${meta.name}: expected ${meta.expected ?? "(none)"}, got ${meta.actual} — ${mark(meta.match)}`,
    );
  }
  return lines.join("\n");
}

interface JudgeCommandOptions {
  args: ParsedArgs;
  deps: CliDeps;
  calibrate: boolean;
}

async function runJudgeCommand(options: JudgeCommandOptions): Promise<number> {
  const { args, deps } = options;
  const [irPath, ...trajectoryFiles] = args.positionals;
  if (irPath === undefined || trajectoryFiles.length === 0) {
    process.stderr.write(
      `error: ${options.calibrate ? "calibrate" : "judge"} requires an IR file and at least one trajectory JSON file.\n\n${usage()}`,
    );
    return 1;
  }

  const ir = await loadIrFile(irPath);
  const cases = await loadCases(trajectoryFiles);

  const judgments: TrajectoryJudgment[] = [];
  const comparisons: JudgmentComparison[] = [];

  for (const [index, trajectoryCase] of cases.entries()) {
    if (options.calibrate && trajectoryCase.expected === undefined) {
      process.stderr.write(
        `error: calibrate requires expected verdicts; trajectory ${trajectoryCase.trajectory.id} (case ${index}) has none.\n`,
      );
      return 1;
    }
    // Progress goes to stderr so --json stdout stays machine-readable.
    process.stderr.write(
      `Judging ${trajectoryCase.trajectory.id} (${index + 1}/${cases.length})...\n`,
    );
    const judgeOptions: Parameters<typeof judgeTrajectory>[0] = {
      ir,
      trajectory: trajectoryCase.trajectory,
      verify: !args.noVerify,
    };
    if (deps.complete !== undefined) judgeOptions.complete = deps.complete;
    if (args.model !== undefined) judgeOptions.gateway = { model: args.model };
    const judgment = await judgeTrajectory(judgeOptions);
    judgments.push(judgment);
    if (trajectoryCase.expected !== undefined) {
      comparisons.push(compareToExpected(judgment, trajectoryCase.expected));
    }
  }

  if (!options.calibrate) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify(judgments, null, 2)}\n`);
    } else {
      process.stdout.write(`${judgments.map(formatJudgment).join("\n\n")}\n`);
    }
    return 0;
  }

  const metaTotal = comparisons.reduce(
    (sum, comparison) => sum + comparison.metaComparisons.length,
    0,
  );
  const metaAgreed = comparisons.reduce(
    (sum, comparison) => sum + comparison.metaComparisons.filter((meta) => meta.match).length,
    0,
  );
  const fileAgreed = comparisons.filter((comparison) => comparison.fileMatch).length;
  const allAgree = metaAgreed === metaTotal && fileAgreed === comparisons.length;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          comparisons,
          judgments,
          totals: {
            metaAgreed,
            metaTotal,
            fileAgreed,
            fileTotal: comparisons.length,
          },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${comparisons.map(formatComparison).join("\n\n")}\n\n`);
    process.stdout.write(
      `meta agreement ${metaAgreed}/${metaTotal}, file agreement ${fileAgreed}/${comparisons.length}\n`,
    );
  }

  return allAgree ? 0 : 1;
}

async function runGenerateCommand(args: ParsedArgs, deps: CliDeps): Promise<number> {
  const [behaviorPath, ...trajectoryFiles] = args.positionals;
  if (behaviorPath === undefined) {
    process.stderr.write(`error: generate requires a behavior spec path.\n\n${usage()}`);
    return 1;
  }
  if (trajectoryFiles.length === 0) {
    process.stderr.write(
      "error: generate needs at least one sample trajectory JSON to bind predicates to your event vocabulary.\n",
    );
    return 1;
  }

  let record: BehaviorSpec;
  try {
    record = await loadBehaviorSpec(behaviorPath);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`error: ${behaviorPath} is not a valid behavior spec.\n`);
    return 1;
  }

  const cases = await loadCases(trajectoryFiles);
  const complete =
    deps.complete ??
    ((messages) =>
      completeWithBraintrustGateway(
        messages,
        args.model === undefined ? {} : { model: args.model },
      ));
  const outPath = args.out ?? path.join(path.dirname(record.location), "judge.yaml");

  if (args.web) {
    const ir = await runWebInterview({
      input: {
        behaviorName: record.name,
        behaviorBody: record.body,
        trajectories: cases.map((trajectoryCase) => trajectoryCase.trajectory),
      },
      complete,
      outPath,
      writeIr: async (generated) => {
        await fs.writeFile(outPath, serializeIr(generated), "utf8");
        return outPath;
      },
      log: (line) => process.stdout.write(`${line}\n`),
      openBrowser: deps.openBrowser ?? openBrowserCommand,
    });

    if (ir === undefined) {
      process.stdout.write("Aborted; nothing written.\n");
      return 1;
    }
    process.stdout.write(`${generateSuccessBox(outPath)}\n`);
    return 0;
  }

  let readline: ReturnType<typeof createInterface> | undefined;
  const ask =
    deps.ask ??
    ((question: string, prefill?: string) => {
      readline ??= createInterface({ input: process.stdin, output: process.stdout });
      const answer = readline.question(question);
      // question() has printed the prompt; write() puts the current text in
      // the line buffer so the user edits it in place instead of retyping.
      if (prefill !== undefined) readline.write(prefill);
      return answer;
    });

  try {
    const ir = await runInterview(
      {
        behaviorName: record.name,
        behaviorBody: record.body,
        trajectories: cases.map((trajectoryCase) => trajectoryCase.trajectory),
      },
      {
        complete,
        ask,
        write: (line) => process.stdout.write(`${line}\n`),
      },
    );

    if (ir === undefined) {
      process.stdout.write("Aborted; nothing written.\n");
      return 1;
    }

    await fs.writeFile(outPath, serializeIr(ir), "utf8");
    process.stdout.write(`${generateSuccessBox(outPath)}\n`);
    return 0;
  } finally {
    readline?.close();
  }
}

/** Celebration box for a written judge; keeps a "Wrote <path>" line inside. */
function generateSuccessBox(outPath: string): string {
  const lines = [`✅ Your judge is ready!`, `Wrote ${outPath}`];
  // The check-mark emoji renders two columns wide in terminals.
  const displayWidth = (text: string) =>
    [...text].reduce((sum, char) => sum + (char === "✅" ? 2 : 1), 0);
  const innerWidth = Math.max(...lines.map(displayWidth));
  const body = lines.map((line) => `│  ${line}${" ".repeat(innerWidth - displayWidth(line))}  │`);
  return [`╭${"─".repeat(innerWidth + 4)}╮`, ...body, `╰${"─".repeat(innerWidth + 4)}╯`].join("\n");
}

/** Best-effort platform browser opener; the printed URL is the fallback. */
function openBrowserCommand(url: string): void {
  let command: string;
  let commandArgs: string[];
  if (process.platform === "darwin") {
    command = "open";
    commandArgs = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    commandArgs = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    commandArgs = [url];
  }
  try {
    const child = spawn(command, commandArgs, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignore: the URL was already printed.
  }
}

export async function main(argv = process.argv.slice(2), deps: CliDeps = {}): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    return 1;
  }

  if (args.version) {
    process.stdout.write(`${await packageVersion()}\n`);
    return 0;
  }

  if (args.help || args.command === undefined) {
    process.stdout.write(usage());
    return args.help ? 0 : 1;
  }

  await (deps.loadEnv ?? applyNearestDotEnv)();

  try {
    if (args.command === "generate") return await runGenerateCommand(args, deps);
    if (args.command === "judge") {
      return await runJudgeCommand({ args, deps, calibrate: false });
    }
    if (args.command === "calibrate") {
      return await runJudgeCommand({ args, deps, calibrate: true });
    }
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  process.stderr.write(`error: unknown command \`${args.command}\`\n\n${usage()}`);
  return 1;
}

function isMainEntry(entry: string | undefined): boolean {
  if (entry === undefined) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  // Bin installs invoke this file through a symlink, while Node realpaths the
  // main module by default; compare against the resolved path too.
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainEntry(process.argv[1])) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
