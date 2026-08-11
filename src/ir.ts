import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { BehaviorVerdict } from "./trajectory.js";

export interface EventMatcher {
  action?: string;
  actor?: "user" | "agent" | "tool";
  contentIncludes?: string;
  metadata?: Record<string, string>;
}

/** A single matcher, or an array meaning "any of these match". */
export type EventPattern = EventMatcher | EventMatcher[];

export type Trigger =
  | { description: string; match: EventPattern }
  | { description: string; semantic: true };

export type PredicateCheck =
  | { type: "ordering"; quote: string; first: EventPattern; before: EventPattern }
  | { type: "pairing"; quote: string; each: EventPattern; followedBy: EventPattern }
  | { type: "required"; quote: string; match: EventPattern; after?: EventPattern }
  | { type: "forbidden"; quote: string; match: EventPattern; after?: EventPattern }
  | {
      type: "count";
      quote: string;
      match: EventPattern;
      min?: number;
      max?: number;
      after?: EventPattern;
      /** "content" or "metadata.<key>": count distinct values instead of raw matches. */
      distinctBy?: string;
    };

export interface SemanticCheck {
  quote: string;
  question: string;
}

export interface MetaBehaviorIr {
  name: string;
  trigger: Trigger;
  checks: PredicateCheck[];
  semanticChecks: SemanticCheck[];
}

export interface JudgeIr {
  version: 1;
  behavior: string;
  metaBehaviors: MetaBehaviorIr[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid judge IR at ${path}: ${message}`);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "must be a non-empty string.");
  }
  return value;
}

const MATCHER_KEYS = new Set(["action", "actor", "contentIncludes", "metadata"]);

function parseMatcher(value: unknown, path: string): EventMatcher {
  if (!isRecord(value)) fail(path, "must be an object.");
  const keys = Object.keys(value);
  if (keys.length === 0) fail(path, "matcher must set at least one field.");
  for (const key of keys) {
    if (!MATCHER_KEYS.has(key)) fail(path, `unknown matcher field \`${key}\`.`);
  }
  const matcher: EventMatcher = {};
  if (value.action !== undefined) matcher.action = requireString(value.action, `${path}.action`);
  if (value.actor !== undefined) {
    if (value.actor !== "user" && value.actor !== "agent" && value.actor !== "tool") {
      fail(`${path}.actor`, "must be user, agent, or tool.");
    }
    matcher.actor = value.actor;
  }
  if (value.contentIncludes !== undefined) {
    matcher.contentIncludes = requireString(value.contentIncludes, `${path}.contentIncludes`);
  }
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) fail(`${path}.metadata`, "must be an object.");
    const metadata: Record<string, string> = {};
    for (const [key, metadataValue] of Object.entries(value.metadata)) {
      metadata[key] = requireString(metadataValue, `${path}.metadata.${key}`);
    }
    if (Object.keys(metadata).length === 0) {
      fail(`${path}.metadata`, "must set at least one key.");
    }
    matcher.metadata = metadata;
  }
  return matcher;
}

function parseMatch(value: unknown, path: string): EventPattern {
  if (Array.isArray(value)) {
    if (value.length === 0) fail(path, "any-of match must contain at least one matcher.");
    return value.map((entry, index) => parseMatcher(entry, `${path}[${index}]`));
  }
  return parseMatcher(value, path);
}

function parseTrigger(value: unknown, path: string): Trigger {
  if (!isRecord(value)) fail(path, "must be an object.");
  const description = requireString(value.description, `${path}.description`);
  if (value.semantic !== undefined) {
    if (value.semantic !== true) fail(`${path}.semantic`, "must be true when present.");
    if (value.match !== undefined) fail(path, "cannot set both semantic and match.");
    return { description, semantic: true };
  }
  if (value.match === undefined) fail(path, "must set either match or semantic: true.");
  return { description, match: parseMatch(value.match, `${path}.match`) };
}

function parseCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, "must be a non-negative integer.");
  }
  return value;
}

function parseDistinctBy(value: unknown, path: string): string {
  const raw = requireString(value, path);
  if (raw === "content") return raw;
  if (raw.startsWith("metadata.") && raw.length > "metadata.".length) return raw;
  fail(path, 'must be "content" or "metadata.<key>".');
}

function parseCheck(value: unknown, path: string): PredicateCheck {
  if (!isRecord(value)) fail(path, "must be an object.");
  const quote = requireString(value.quote, `${path}.quote`);
  const type = value.type;
  if (type === "ordering") {
    return {
      type,
      quote,
      first: parseMatch(value.first, `${path}.first`),
      before: parseMatch(value.before, `${path}.before`),
    };
  }
  if (type === "pairing") {
    return {
      type,
      quote,
      each: parseMatch(value.each, `${path}.each`),
      followedBy: parseMatch(value.followedBy, `${path}.followedBy`),
    };
  }
  if (type === "required" || type === "forbidden") {
    const match = parseMatch(value.match, `${path}.match`);
    const after = value.after === undefined ? undefined : parseMatch(value.after, `${path}.after`);
    if (type === "required") {
      return after === undefined ? { type, quote, match } : { type, quote, match, after };
    }
    return after === undefined ? { type, quote, match } : { type, quote, match, after };
  }
  if (type === "count") {
    const min = value.min === undefined ? undefined : parseCount(value.min, `${path}.min`);
    const max = value.max === undefined ? undefined : parseCount(value.max, `${path}.max`);
    if (min === undefined && max === undefined) {
      fail(path, "count check must set min and/or max.");
    }
    const check: Extract<PredicateCheck, { type: "count" }> = {
      type: "count",
      quote,
      match: parseMatch(value.match, `${path}.match`),
    };
    if (min !== undefined) check.min = min;
    if (max !== undefined) check.max = max;
    if (value.after !== undefined) check.after = parseMatch(value.after, `${path}.after`);
    if (value.distinctBy !== undefined) {
      check.distinctBy = parseDistinctBy(value.distinctBy, `${path}.distinctBy`);
    }
    return check;
  }
  fail(`${path}.type`, "must be ordering, pairing, required, forbidden, or count.");
}

function parseSemanticCheck(value: unknown, path: string): SemanticCheck {
  if (!isRecord(value)) fail(path, "must be an object.");
  return {
    quote: requireString(value.quote, `${path}.quote`),
    question: requireString(value.question, `${path}.question`),
  };
}

function parseMetaBehavior(value: unknown, path: string): MetaBehaviorIr {
  if (!isRecord(value)) fail(path, "must be an object.");
  const checks = value.checks ?? [];
  const semanticChecks = value.semanticChecks ?? [];
  if (!Array.isArray(checks)) fail(`${path}.checks`, "must be an array.");
  if (!Array.isArray(semanticChecks)) fail(`${path}.semanticChecks`, "must be an array.");
  const parsed: MetaBehaviorIr = {
    name: requireString(value.name, `${path}.name`),
    trigger: parseTrigger(value.trigger, `${path}.trigger`),
    checks: checks.map((check, index) => parseCheck(check, `${path}.checks[${index}]`)),
    semanticChecks: semanticChecks.map((check, index) =>
      parseSemanticCheck(check, `${path}.semanticChecks[${index}]`),
    ),
  };
  if (parsed.checks.length === 0 && parsed.semanticChecks.length === 0) {
    fail(path, "must define at least one check or semantic check.");
  }
  return parsed;
}

export function parseIr(source: string): JudgeIr {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    throw new Error(
      `Invalid judge IR: not valid YAML (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!isRecord(parsed)) fail("$", "must be a YAML mapping.");
  if (parsed.version !== 1) fail("version", "must be 1.");
  const behavior = requireString(parsed.behavior, "behavior");
  if (!Array.isArray(parsed.metaBehaviors) || parsed.metaBehaviors.length === 0) {
    fail("metaBehaviors", "must be a non-empty array.");
  }
  const metaBehaviors = parsed.metaBehaviors.map((entry, index) =>
    parseMetaBehavior(entry, `metaBehaviors[${index}]`),
  );
  const names = metaBehaviors.map((meta) => meta.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    fail("metaBehaviors", `duplicate meta-behavior names: ${[...new Set(duplicates)].join(", ")}.`);
  }
  return { version: 1, behavior, metaBehaviors };
}

export function serializeIr(ir: JudgeIr): string {
  return stringifyYaml(ir, { lineWidth: 100 });
}

export function foldBehaviorVerdicts(verdicts: BehaviorVerdict[]): BehaviorVerdict {
  if (verdicts.length === 0) {
    throw new Error("Cannot fold a behavior with no meta-behavior verdicts.");
  }
  if (verdicts.includes("false")) return "false";
  if (verdicts.every((verdict) => verdict === "na")) return "na";
  return "true";
}

export function behaviorVerdictToScore(verdict: BehaviorVerdict): number | null {
  if (verdict === "true") return 1;
  if (verdict === "false") return 0;
  return null;
}
