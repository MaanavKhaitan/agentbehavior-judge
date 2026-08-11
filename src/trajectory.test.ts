import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { taxCase } from "./taxFixtures.js";
import { loadTrajectoryFile } from "./trajectory.js";

let temporaryDirectories: string[] = [];

async function writeTrajectoryFile(content: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "behavior-judge-trajectory-test-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "trajectory.json");
  await writeFile(filePath, content, "utf8");
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories = [];
});

describe("loadTrajectoryFile", () => {
  it("round-trips a wrapped trajectory with expected verdicts", async () => {
    const { trajectory, expected } = taxCase("secondary-then-primary");
    const filePath = await writeTrajectoryFile(JSON.stringify({ trajectory, expected }));

    const [loaded] = await loadTrajectoryFile(filePath);

    expect(loaded!.trajectory).toEqual(trajectory);
    expect(loaded!.expected).toEqual(expected);
  });

  it("rejects a trajectory that omits complete", async () => {
    const { trajectory } = taxCase("secondary-then-primary");
    const filePath = await writeTrajectoryFile(
      JSON.stringify({ ...trajectory, complete: undefined }),
    );

    await expect(loadTrajectoryFile(filePath)).rejects.toThrow(/complete must be a boolean/);
  });
});
