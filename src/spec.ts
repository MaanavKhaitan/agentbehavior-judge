import { promises as fs } from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

/**
 * A loaded Agent Behavior spec: the frontmatter identity fields plus the
 * markdown body whose H2 sections name the meta-behaviors.
 */
export interface BehaviorSpec {
  name: string;
  description: string;
  /** Resolved path of the BEHAVIOR.md file the spec was read from. */
  location: string;
  body: string;
}

const FRONTMATTER_OPEN = /^---[ \t]*(?:\r?\n|$)/;
const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${source}: frontmatter field ${field} must be a non-empty string.`);
  }
  return value;
}

/**
 * Load a BEHAVIOR.md spec from a file path or the directory containing it.
 * Deliberately minimal: it enforces only what judging needs (frontmatter
 * `name`/`description` plus a markdown body). Lint specs against the full
 * Agent Behavior standard with the `agentbehavior` CLI.
 */
export async function loadBehaviorSpec(specPath: string): Promise<BehaviorSpec> {
  let filePath = specPath;
  let stat;
  try {
    stat = await fs.stat(specPath);
  } catch (error) {
    throw new Error(`${specPath}: cannot read behavior spec.`, { cause: error });
  }
  if (stat.isDirectory()) {
    filePath = path.join(specPath, "BEHAVIOR.md");
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${filePath}: cannot read behavior spec.`, { cause: error });
  }

  if (!FRONTMATTER_OPEN.test(content)) {
    throw new Error(`${filePath}: BEHAVIOR.md must start with YAML frontmatter delimited by ---.`);
  }
  const match = content.match(FRONTMATTER_BLOCK);
  if (!match) {
    throw new Error(
      `${filePath}: YAML frontmatter must have a closing --- delimiter on its own line.`,
    );
  }

  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (error) {
    throw new Error(
      `${filePath}: YAML frontmatter parse error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(data)) {
    throw new Error(`${filePath}: YAML frontmatter must parse to a mapping/object.`);
  }

  return {
    name: requireString(data.name, "name", filePath),
    description: requireString(data.description, "description", filePath),
    location: filePath,
    body: match[2] ?? "",
  };
}
