import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { applyNearestDotEnv, loadNearestDotEnv } from "./env.js";

let temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "behavior-judge-env-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories = [];
});

describe("loadNearestDotEnv", () => {
  it("parses assignments, skipping comments, blanks, and malformed lines", async () => {
    const directory = await makeTempDir();
    await writeFile(
      path.join(directory, ".env"),
      [
        "# a comment",
        "",
        "BRAINTRUST_API_KEY=sk-test",
        'DOUBLE_QUOTED="a value"',
        "SINGLE_QUOTED='b'",
        "SPACED = padded ",
        "1INVALID_KEY=skipped",
        "no-equals-sign",
      ].join("\n"),
      { flush: true },
    );

    await expect(loadNearestDotEnv(directory)).resolves.toEqual({
      BRAINTRUST_API_KEY: "sk-test",
      DOUBLE_QUOTED: "a value",
      SINGLE_QUOTED: "b",
      SPACED: "padded",
    });
  });

  it("keeps the first value when a key repeats", async () => {
    const directory = await makeTempDir();
    await writeFile(path.join(directory, ".env"), "KEY=first\nKEY=second", { flush: true });

    await expect(loadNearestDotEnv(directory)).resolves.toEqual({ KEY: "first" });
  });

  it("walks up to the nearest .env and stops at the first one found", async () => {
    const root = await makeTempDir();
    const nested = path.join(root, "packages", "judge");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, ".env"), "FROM_ROOT=yes", { flush: true });

    await expect(loadNearestDotEnv(nested)).resolves.toEqual({ FROM_ROOT: "yes" });

    await writeFile(path.join(nested, ".env"), "FROM_NESTED=yes", { flush: true });
    await expect(loadNearestDotEnv(nested)).resolves.toEqual({ FROM_NESTED: "yes" });
  });
});

describe("applyNearestDotEnv", () => {
  it("fills missing variables without overwriting ones already set", async () => {
    const directory = await makeTempDir();
    await writeFile(
      path.join(directory, ".env"),
      "BRAINTRUST_API_KEY=sk-file\nBRAINTRUST_MODEL=model-file",
      { flush: true },
    );
    const env: NodeJS.ProcessEnv = { BRAINTRUST_API_KEY: "sk-shell" };

    await applyNearestDotEnv(env, directory);

    expect(env).toEqual({ BRAINTRUST_API_KEY: "sk-shell", BRAINTRUST_MODEL: "model-file" });
  });
});
