import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadBehaviorSpec } from "./spec.js";

let temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "behavior-judge-spec-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories = [];
});

const validSpec = `---
name: primary-source-tax-research
description: Tax research conduct.
---

# Primary-source tax research

## Read the tax research skill before beginning source research

The agent first reads the tax research skill.
`;

async function writeSpec(content: string): Promise<string> {
  const directory = await makeTempDir();
  const filePath = path.join(directory, "BEHAVIOR.md");
  await writeFile(filePath, content, { flush: true });
  return filePath;
}

describe("loadBehaviorSpec", () => {
  it("loads name, description, and body from a BEHAVIOR.md file", async () => {
    const filePath = await writeSpec(validSpec);
    const spec = await loadBehaviorSpec(filePath);
    expect(spec.name).toBe("primary-source-tax-research");
    expect(spec.description).toBe("Tax research conduct.");
    expect(spec.location).toBe(filePath);
    expect(spec.body).toContain("## Read the tax research skill");
    expect(spec.body).not.toContain("---");
  });

  it("resolves a behavior directory to its BEHAVIOR.md", async () => {
    const filePath = await writeSpec(validSpec);
    const spec = await loadBehaviorSpec(path.dirname(filePath));
    expect(spec.name).toBe("primary-source-tax-research");
    expect(spec.location).toBe(filePath);
  });

  it("rejects a missing path", async () => {
    await expect(loadBehaviorSpec("no-such-behavior")).rejects.toThrow("cannot read behavior spec");
  });

  it("rejects a directory without a BEHAVIOR.md", async () => {
    const directory = await makeTempDir();
    await expect(loadBehaviorSpec(directory)).rejects.toThrow("cannot read behavior spec");
  });

  it("rejects content without frontmatter", async () => {
    const filePath = await writeSpec("# No frontmatter\n\nBody.\n");
    await expect(loadBehaviorSpec(filePath)).rejects.toThrow("must start with YAML frontmatter");
  });

  it("rejects unclosed frontmatter", async () => {
    const filePath = await writeSpec("---\nname: x\ndescription: y\n\nBody without close.\n");
    await expect(loadBehaviorSpec(filePath)).rejects.toThrow("closing --- delimiter");
  });

  it("rejects frontmatter that is not a mapping", async () => {
    const filePath = await writeSpec("---\n- just\n- a list\n---\n\nBody.\n");
    await expect(loadBehaviorSpec(filePath)).rejects.toThrow("must parse to a mapping");
  });

  it("rejects a missing name", async () => {
    const filePath = await writeSpec("---\ndescription: Tax research conduct.\n---\n\nBody.\n");
    await expect(loadBehaviorSpec(filePath)).rejects.toThrow("field name must be a non-empty");
  });

  it("rejects an empty description", async () => {
    const filePath = await writeSpec('---\nname: x\ndescription: "  "\n---\n\nBody.\n');
    await expect(loadBehaviorSpec(filePath)).rejects.toThrow(
      "field description must be a non-empty",
    );
  });
});
