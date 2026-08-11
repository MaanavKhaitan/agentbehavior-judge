import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { parseIr, serializeIr } from "./ir.js";
import { compareToExpected, judgeTrajectory } from "./judge.js";
import { loadTrajectoryFile } from "./trajectory.js";

/**
 * The two predicate-only examples: every trigger and every check is
 * deterministic, so the checked-in expected verdicts must be reproducible
 * offline with zero LLM calls (verify-on-false disabled, completion seam
 * throwing). The tax example stays the semantic showcase and is covered in
 * judge.test.ts with scripted completions.
 */
const PREDICATE_ONLY_EXAMPLES = ["verified-refund-support", "staged-rollout-deploys"];

for (const example of PREDICATE_ONLY_EXAMPLES) {
  describe(`examples/${example}`, () => {
    const exampleUrl = new URL(`../examples/${example}/`, import.meta.url);

    async function loadIr() {
      return parseIr(await readFile(new URL("judge.yaml", exampleUrl), "utf8"));
    }

    it("round-trips the checked-in IR through parse and serialize", async () => {
      const ir = await loadIr();
      expect(parseIr(serializeIr(ir))).toEqual(ir);
    });

    it("reproduces every expected verdict offline with zero LLM calls", async () => {
      const ir = await loadIr();
      const trajectoriesUrl = new URL("trajectories/", exampleUrl);
      const files = (await readdir(trajectoriesUrl)).filter((file) => file.endsWith(".json"));
      files.sort();
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const cases = await loadTrajectoryFile(fileURLToPath(new URL(file, trajectoriesUrl)));
        for (const trajectoryCase of cases) {
          expect(trajectoryCase.expected, `${file} must carry expected verdicts`).toBeDefined();
          const judgment = await judgeTrajectory({
            ir,
            trajectory: trajectoryCase.trajectory,
            complete: () => Promise.reject(new Error(`unexpected LLM call judging ${file}`)),
            verify: false,
          });
          const comparison = compareToExpected(judgment, trajectoryCase.expected!);
          const mismatches = comparison.metaComparisons
            .filter((meta) => !meta.match)
            .map(
              (meta) => `${meta.name}: expected ${meta.expected ?? "(none)"}, got ${meta.actual}`,
            );
          expect({ file, fileMatch: comparison.fileMatch, mismatches }).toEqual({
            file,
            fileMatch: true,
            mismatches: [],
          });
        }
      }
    });
  });
}
