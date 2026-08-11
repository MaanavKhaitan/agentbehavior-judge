import { stringify as stringifyYaml } from "yaml";

import { completeJsonWithRetry, parseJsonObject, type JudgeCompletion } from "./gateway.js";
import {
  parseIr,
  serializeIr,
  type EventMatcher,
  type EventPattern,
  type JudgeIr,
  type MetaBehaviorIr,
  type PredicateCheck,
  type SemanticCheck,
  type Trigger,
} from "./ir.js";
import { matchesAny } from "./predicates.js";
import type { AgentTrajectory, TrajectoryEvent } from "./trajectory.js";

export interface ActionVocabulary {
  action: string;
  actors: string[];
  /** metadata key -> one example value */
  metadataKeys: Record<string, string>;
  sampleEvent: TrajectoryEvent;
}

export function extractMetaBehaviorNames(behaviorBody: string): string[] {
  const matches = [...behaviorBody.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)];
  const names = matches.map((match) => match[1]!.trim());
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(
      `Behavior contains duplicate H2 headings: ${[...new Set(duplicates)].join(", ")}.`,
    );
  }
  return names;
}

export function extractVocabulary(trajectories: AgentTrajectory[]): ActionVocabulary[] {
  const byAction = new Map<string, ActionVocabulary>();
  for (const trajectory of trajectories) {
    for (const event of trajectory.events) {
      let entry = byAction.get(event.action);
      if (entry === undefined) {
        entry = { action: event.action, actors: [], metadataKeys: {}, sampleEvent: event };
        byAction.set(event.action, entry);
      }
      if (!entry.actors.includes(event.actor)) entry.actors.push(event.actor);
      for (const [key, value] of Object.entries(event.metadata ?? {})) {
        entry.metadataKeys[key] ??= value;
      }
    }
  }
  return [...byAction.values()].sort((a, b) => a.action.localeCompare(b.action));
}

const PROPOSAL_SYSTEM_PROMPT = `You compile an Agent Behavior spec into a judge intermediate representation (IR).

The IR decomposes the spec into meta-behaviors (one per H2 section). Each meta-behavior has:
- "trigger": when the meta-behavior applies. Either {"description", "match"} (an event matcher, or array of matchers meaning any-of) or {"description", "semantic": true} when no event pattern can detect it.
- "checks": deterministic predicate checks over trajectory events. Types:
  - {"type": "ordering", "quote", "first": <match>, "before": <match>} — the first \`first\`-match must precede the first \`before\`-match.
  - {"type": "required", "quote", "match": <match>} — a matching event must exist.
  - {"type": "forbidden", "quote", "match": <match>} — no matching event may exist.
  - {"type": "count", "quote", "match": <match>, "min"?, "max"?} — match count within bounds.
- "semanticChecks": [{"quote", "question"}] — clauses only an LLM can judge; the question must be answerable yes/no from the trajectory.

An event matcher is {"action"?, "actor"?, "contentIncludes"?, "metadata"?: {key: value}}; all set fields must match an event.

HARD CONSTRAINT: matchers may only use "action" values and "metadata" keys that appear in the observed vocabulary you are given. A clause whose detection would need any other action or metadata key must become a semantic check instead (or be part of the trigger description for a semantic trigger). Never invent vocabulary.

Every check and semantic check carries a "quote": a short verbatim excerpt from the spec text that the check enforces.

Return JSON only:
{"metaBehaviors": [{"name", "trigger", "checks": [...], "semanticChecks": [...]}]}

Use the exact H2 headings as names when headings are provided. Prefer deterministic checks over semantic checks whenever the vocabulary allows; use semantic checks for judgment calls (e.g. "bases its conclusion on the source").`;

export function buildProposalMessages(input: {
  behaviorName: string;
  behaviorBody: string;
  metaBehaviorNames: string[];
  vocabulary: ActionVocabulary[];
}) {
  const headings =
    input.metaBehaviorNames.length > 0
      ? `Required meta-behavior names (exact H2 headings):\n${JSON.stringify(input.metaBehaviorNames)}`
      : "The spec has no H2 headings: propose a decomposition into named meta-behaviors.";
  const vocabulary = input.vocabulary.map((entry) => ({
    action: entry.action,
    actors: entry.actors,
    metadataKeys: entry.metadataKeys,
    sampleEvent: entry.sampleEvent,
  }));
  return [
    { role: "system" as const, content: PROPOSAL_SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: `Behavior name: ${input.behaviorName}

Behavior body:
${input.behaviorBody}

${headings}

Observed event vocabulary (from sample trajectories; the only actions and metadata keys matchers may use):
${JSON.stringify(vocabulary, null, 2)}`,
    },
  ];
}

export function parseProposal(response: string, behaviorName: string): JudgeIr {
  const parsed = parseJsonObject(response);
  const draft = { version: 1, behavior: behaviorName, metaBehaviors: parsed.metaBehaviors };
  return parseIr(stringifyYaml(draft));
}

function matchers(pattern: EventPattern): EventMatcher[] {
  return Array.isArray(pattern) ? pattern : [pattern];
}

function unknownVocabulary(
  pattern: EventPattern,
  actions: Set<string>,
  metadataKeys: Set<string>,
): string[] {
  const problems: string[] = [];
  for (const matcher of matchers(pattern)) {
    if (matcher.action !== undefined && !actions.has(matcher.action)) {
      problems.push(`action \`${matcher.action}\``);
    }
    for (const key of Object.keys(matcher.metadata ?? {})) {
      if (!metadataKeys.has(key)) problems.push(`metadata key \`${key}\``);
    }
  }
  return problems;
}

export interface EnforcementNotice {
  metaBehavior: string;
  demoted: string;
  problems: string[];
}

/**
 * Demote any matcher that references vocabulary absent from the samples:
 * triggers become semantic triggers, checks become semantic checks.
 */
export function enforceVocabulary(
  ir: JudgeIr,
  vocabulary: ActionVocabulary[],
): { ir: JudgeIr; notices: EnforcementNotice[] } {
  const actions = new Set(vocabulary.map((entry) => entry.action));
  const metadataKeys = new Set(vocabulary.flatMap((entry) => Object.keys(entry.metadataKeys)));
  const notices: EnforcementNotice[] = [];

  const metaBehaviors = ir.metaBehaviors.map((meta): MetaBehaviorIr => {
    let trigger: Trigger = meta.trigger;
    if ("match" in trigger) {
      const problems = unknownVocabulary(trigger.match, actions, metadataKeys);
      if (problems.length > 0) {
        notices.push({ metaBehavior: meta.name, demoted: "trigger", problems });
        trigger = { description: trigger.description, semantic: true };
      }
    }

    const checks: PredicateCheck[] = [];
    const semanticChecks: SemanticCheck[] = [...meta.semanticChecks];
    for (const check of meta.checks) {
      const checkPatterns = check.type === "ordering" ? [check.first, check.before] : [check.match];
      const problems = checkPatterns.flatMap((pattern) =>
        unknownVocabulary(pattern, actions, metadataKeys),
      );
      if (problems.length === 0) {
        checks.push(check);
      } else {
        notices.push({ metaBehavior: meta.name, demoted: `${check.type} check`, problems });
        semanticChecks.push({
          quote: check.quote,
          question: `Does the agent's conduct satisfy this clause: "${check.quote}"?`,
        });
      }
    }

    return { name: meta.name, trigger, checks, semanticChecks };
  });

  return { ir: { ...ir, metaBehaviors }, notices };
}

export interface InterviewDeps {
  complete: JudgeCompletion;
  ask: (question: string) => Promise<string>;
  write: (line: string) => void;
}

export interface InterviewInput {
  behaviorName: string;
  behaviorBody: string;
  trajectories: AgentTrajectory[];
}

function firstMatch(
  trajectories: AgentTrajectory[],
  pattern: EventPattern,
): { trajectory: AgentTrajectory; event: TrajectoryEvent } | undefined {
  for (const trajectory of trajectories) {
    for (const event of trajectory.events) {
      if (matchesAny(event, pattern)) return { trajectory, event };
    }
  }
  return undefined;
}

function describeEvidence(trajectories: AgentTrajectory[], pattern: EventPattern): string {
  const found = firstMatch(trajectories, pattern);
  if (found === undefined) return "  evidence: no sample event matches";
  return `  evidence: matches ${found.trajectory.id}/${found.event.id} (${found.event.actor} ${found.event.action})`;
}

function renderPattern(pattern: EventPattern): string {
  return JSON.stringify(pattern);
}

async function askChoice(deps: InterviewDeps, prompt: string, choices: string[]): Promise<string> {
  for (;;) {
    const answer = (await deps.ask(`${prompt} `)).trim().toLowerCase();
    if (answer === "" && choices.length > 0) return choices[0]!;
    if (choices.includes(answer)) return answer;
    deps.write(`Please answer one of: ${choices.join(", ")}`);
  }
}

async function interviewNames(
  proposed: JudgeIr,
  hasHeadings: boolean,
  deps: InterviewDeps,
): Promise<MetaBehaviorIr[]> {
  if (hasHeadings) return proposed.metaBehaviors;

  const kept: MetaBehaviorIr[] = [];
  deps.write("The spec has no H2 headings; confirm the proposed meta-behavior names.");
  for (const meta of proposed.metaBehaviors) {
    const answer = await askChoice(
      deps,
      `Meta-behavior "${meta.name}" — [y] keep / [e] rename / [d] drop`,
      ["y", "e", "d"],
    );
    if (answer === "d") continue;
    if (answer === "e") {
      const name = (await deps.ask("New name: ")).trim();
      kept.push({ ...meta, name: name.length > 0 ? name : meta.name });
    } else {
      kept.push(meta);
    }
  }
  return kept;
}

async function interviewTrigger(
  meta: MetaBehaviorIr,
  trajectories: AgentTrajectory[],
  deps: InterviewDeps,
): Promise<Trigger> {
  const trigger = meta.trigger;
  deps.write(`\n## ${meta.name}`);
  deps.write(`Trigger: ${trigger.description}`);
  if ("match" in trigger) {
    deps.write(`  match: ${renderPattern(trigger.match)}`);
    deps.write(describeEvidence(trajectories, trigger.match));
    const answer = await askChoice(deps, "[y] accept / [s] force semantic / [e] edit description", [
      "y",
      "s",
      "e",
    ]);
    if (answer === "s") return { description: trigger.description, semantic: true };
    if (answer === "e") {
      const description = (await deps.ask("New trigger description: ")).trim();
      return description.length > 0 ? { ...trigger, description } : trigger;
    }
    return trigger;
  }

  deps.write("  (semantic trigger: judged by one scoped LLM call)");
  const answer = await askChoice(deps, "[y] accept / [e] edit description", ["y", "e"]);
  if (answer === "e") {
    const description = (await deps.ask("New trigger description: ")).trim();
    return description.length > 0 ? { description, semantic: true } : trigger;
  }
  return trigger;
}

async function interviewChecks(
  meta: MetaBehaviorIr,
  trajectories: AgentTrajectory[],
  deps: InterviewDeps,
): Promise<{ checks: PredicateCheck[]; demoted: SemanticCheck[] }> {
  const checks: PredicateCheck[] = [];
  const demoted: SemanticCheck[] = [];
  for (const check of meta.checks) {
    deps.write(`Check (${check.type}): "${check.quote}"`);
    if (check.type === "ordering") {
      deps.write(`  first: ${renderPattern(check.first)}`);
      deps.write(describeEvidence(trajectories, check.first));
      deps.write(`  before: ${renderPattern(check.before)}`);
      deps.write(describeEvidence(trajectories, check.before));
    } else {
      deps.write(`  match: ${renderPattern(check.match)}`);
      deps.write(describeEvidence(trajectories, check.match));
    }
    const answer = await askChoice(deps, "[y] accept / [s] demote to semantic / [d] drop", [
      "y",
      "s",
      "d",
    ]);
    if (answer === "y") checks.push(check);
    if (answer === "s") {
      demoted.push({
        quote: check.quote,
        question: `Does the agent's conduct satisfy this clause: "${check.quote}"?`,
      });
    }
  }
  return { checks, demoted };
}

async function interviewSemanticChecks(
  semanticChecks: SemanticCheck[],
  deps: InterviewDeps,
): Promise<SemanticCheck[]> {
  const kept: SemanticCheck[] = [];
  for (const check of semanticChecks) {
    deps.write(`Semantic check: "${check.quote}"`);
    deps.write(`  question: ${check.question}`);
    const answer = await askChoice(deps, "[y] accept / [e] retype question / [d] drop", [
      "y",
      "e",
      "d",
    ]);
    if (answer === "d") continue;
    if (answer === "e") {
      const question = (await deps.ask("New question: ")).trim();
      kept.push(question.length > 0 ? { ...check, question } : check);
    } else {
      kept.push(check);
    }
  }
  return kept;
}

/**
 * Run the generate interview. Returns the confirmed IR, or undefined when the
 * user declines to write it.
 */
export async function runInterview(
  input: InterviewInput,
  deps: InterviewDeps,
): Promise<JudgeIr | undefined> {
  if (input.trajectories.length === 0) {
    throw new Error(
      "generate needs at least one sample trajectory JSON to bind predicates to your event vocabulary.",
    );
  }

  const metaBehaviorNames = extractMetaBehaviorNames(input.behaviorBody);
  const vocabulary = extractVocabulary(input.trajectories);
  deps.write(
    `Observed vocabulary: ${vocabulary.length} action(s) across ${input.trajectories.length} trajectory(ies).`,
  );

  const proposal = await completeJsonWithRetry(
    deps.complete,
    buildProposalMessages({
      behaviorName: input.behaviorName,
      behaviorBody: input.behaviorBody,
      metaBehaviorNames,
      vocabulary,
    }),
    (response) => parseProposal(response, input.behaviorName),
  );

  const { ir: enforced, notices } = enforceVocabulary(proposal, vocabulary);
  for (const notice of notices) {
    deps.write(
      `note: demoted ${notice.demoted} in "${notice.metaBehavior}" to semantic (unknown ${notice.problems.join(", ")}).`,
    );
  }

  const namedMetaBehaviors = await interviewNames(enforced, metaBehaviorNames.length > 0, deps);

  const metaBehaviors: MetaBehaviorIr[] = [];
  for (const meta of namedMetaBehaviors) {
    const trigger = await interviewTrigger(meta, input.trajectories, deps);
    const { checks, demoted } = await interviewChecks(meta, input.trajectories, deps);
    const semanticChecks = await interviewSemanticChecks(
      [...meta.semanticChecks, ...demoted],
      deps,
    );
    if (checks.length === 0 && semanticChecks.length === 0) {
      deps.write(`note: "${meta.name}" has no checks left; dropping it.`);
      continue;
    }
    metaBehaviors.push({ name: meta.name, trigger, checks, semanticChecks });
  }

  if (metaBehaviors.length === 0) {
    throw new Error("No meta-behaviors left after the interview; nothing to write.");
  }

  const ir: JudgeIr = { version: 1, behavior: input.behaviorName, metaBehaviors };
  const rendered = serializeIr(ir);
  deps.write("\nGenerated judge IR:\n");
  deps.write(rendered);
  const confirm = await askChoice(deps, "Write this IR? [y] yes / [n] no", ["y", "n"]);
  return confirm === "y" ? ir : undefined;
}
