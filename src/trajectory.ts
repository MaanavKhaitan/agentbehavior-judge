import { promises as fs } from "node:fs";

export interface TrajectoryEvent {
  id: string;
  actor: "user" | "agent" | "tool";
  action: string;
  content: string;
  metadata?: Record<string, string>;
}

export interface AgentTrajectory {
  id: string;
  description: string;
  complete: boolean;
  events: TrajectoryEvent[];
}

export type BehaviorVerdict = "true" | "false" | "na";
export type NaReason = "not_applicable" | "insufficient_evidence" | "behavior_not_judgeable";

export interface ExpectedBehaviorJudgment {
  verdict: BehaviorVerdict;
  metaBehaviorVerdicts: Record<string, BehaviorVerdict>;
}

export interface TrajectoryCase {
  trajectory: AgentTrajectory;
  expected?: ExpectedBehaviorJudgment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source}: field ${field} must be a non-empty string.`);
  }
  return value;
}

function parseEvent(value: unknown, index: number, source: string): TrajectoryEvent {
  if (!isRecord(value)) {
    throw new Error(`${source}: events[${index}] must be an object.`);
  }
  const actor = value.actor;
  if (actor !== "user" && actor !== "agent" && actor !== "tool") {
    throw new Error(`${source}: events[${index}].actor must be user, agent, or tool.`);
  }
  const event: TrajectoryEvent = {
    id: requireString(value.id, `events[${index}].id`, source),
    actor,
    action: requireString(value.action, `events[${index}].action`, source),
    content: typeof value.content === "string" ? value.content : "",
  };
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) {
      throw new Error(`${source}: events[${index}].metadata must be an object.`);
    }
    const metadata: Record<string, string> = {};
    for (const [key, metadataValue] of Object.entries(value.metadata)) {
      metadata[key] = String(metadataValue);
    }
    event.metadata = metadata;
  }
  return event;
}

function parseTrajectory(value: Record<string, unknown>, source: string): AgentTrajectory {
  if (!Array.isArray(value.events)) {
    throw new Error(`${source}: trajectory field events must be an array.`);
  }
  const events = value.events.map((event, index) => parseEvent(event, index, source));
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.id)) {
      throw new Error(`${source}: duplicate event id ${event.id}.`);
    }
    ids.add(event.id);
  }
  if (typeof value.complete !== "boolean") {
    throw new Error(`${source}: trajectory field complete must be a boolean.`);
  }
  return {
    id: requireString(value.id, "id", source),
    description: typeof value.description === "string" ? value.description : "",
    complete: value.complete,
    events,
  };
}

function parseVerdict(value: unknown, field: string, source: string): BehaviorVerdict {
  if (value !== "true" && value !== "false" && value !== "na") {
    throw new Error(`${source}: field ${field} must be "true", "false", or "na".`);
  }
  return value;
}

function parseExpected(value: unknown, source: string): ExpectedBehaviorJudgment {
  if (!isRecord(value)) {
    throw new Error(`${source}: expected must be an object.`);
  }
  if (!isRecord(value.metaBehaviorVerdicts)) {
    throw new Error(`${source}: expected.metaBehaviorVerdicts must be an object.`);
  }
  const metaBehaviorVerdicts: Record<string, BehaviorVerdict> = {};
  for (const [name, verdict] of Object.entries(value.metaBehaviorVerdicts)) {
    metaBehaviorVerdicts[name] = parseVerdict(
      verdict,
      `expected.metaBehaviorVerdicts[${name}]`,
      source,
    );
  }
  return {
    verdict: parseVerdict(value.verdict, "expected.verdict", source),
    metaBehaviorVerdicts,
  };
}

function parseCase(value: unknown, source: string): TrajectoryCase {
  if (!isRecord(value)) {
    throw new Error(`${source}: trajectory JSON must be an object or array of objects.`);
  }
  if (isRecord(value.trajectory)) {
    const result: TrajectoryCase = { trajectory: parseTrajectory(value.trajectory, source) };
    if (value.expected !== undefined && value.expected !== null) {
      result.expected = parseExpected(value.expected, source);
    }
    return result;
  }
  return { trajectory: parseTrajectory(value, source) };
}

/**
 * Load trajectory cases from a JSON file. Accepts a bare trajectory, a
 * `{trajectory, expected}` wrapper, or an array of either.
 */
export async function loadTrajectoryFile(filePath: string): Promise<TrajectoryCase[]> {
  const content = await fs.readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${filePath}: not valid JSON.`, { cause: error });
  }
  if (Array.isArray(parsed)) {
    return parsed.map((entry, index) => parseCase(entry, `${filePath}[${index}]`));
  }
  return [parseCase(parsed, filePath)];
}
