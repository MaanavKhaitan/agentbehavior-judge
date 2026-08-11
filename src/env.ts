import { promises as fs } from "node:fs";
import path from "node:path";

function parseDotEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;

  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex === -1) return undefined;

  const key = trimmed.slice(0, equalsIndex).trim();
  let value = trimmed.slice(equalsIndex + 1).trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

async function readDotEnvFile(filePath: string): Promise<Record<string, string> | undefined> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  const vars: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseDotEnvLine(line);
    if (parsed === undefined) continue;
    const [key, value] = parsed;
    vars[key] ??= value;
  }
  return vars;
}

/**
 * Variables from the nearest `.env` file at or above `startDir`; `{}` when no
 * directory on the way to the filesystem root has one. The search stops at the
 * first file found — a package-local `.env` shadows a repo-root one entirely.
 */
export async function loadNearestDotEnv(startDir: string): Promise<Record<string, string>> {
  let directory = path.resolve(startDir);
  for (;;) {
    const vars = await readDotEnvFile(path.join(directory, ".env"));
    if (vars !== undefined) return vars;
    const parent = path.dirname(directory);
    if (parent === directory) return {};
    directory = parent;
  }
}

/**
 * Fill `env` from the nearest `.env` file without overwriting variables that
 * are already set: an explicitly exported variable always beats the file.
 */
export async function applyNearestDotEnv(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd(),
): Promise<void> {
  for (const [key, value] of Object.entries(await loadNearestDotEnv(startDir))) {
    env[key] ??= value;
  }
}
