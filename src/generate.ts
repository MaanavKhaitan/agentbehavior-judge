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
import { matchesAny, matchesEvent } from "./predicates.js";
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
  - {"type": "ordering", "quote", "first": <match>, "before": <match>} — the first \`first\`-match must precede the first \`before\`-match. For one-time precedence clauses like "reads the skill before searching or opening a source".
  - {"type": "pairing", "quote", "each": <match>, "followedBy": <match>} — every \`each\`-match must be followed later by a \`followedBy\`-match. For per-occurrence clauses like "reads the results of every search" or "every failed call is retried or reported".
  - {"type": "required", "quote", "match": <match>, "after"?: <match>} — a matching event must exist. For clauses like "consults a primary source".
  - {"type": "forbidden", "quote", "match": <match>, "after"?: <match>} — no matching event may exist. For clauses like "never contacts external services".
  - {"type": "count", "quote", "match": <match>, "min"?, "max"?, "after"?: <match>, "distinctBy"?: "content" | "metadata.<key>"} — match count within bounds, for clauses like "searches at most three times". "distinctBy" counts distinct values instead of raw matches, for clauses like "consults at least two distinct sources".
  The optional "after" matcher scopes required/forbidden/count to events after the first \`after\`-match, for "once X happens..." clauses like "after giving the final answer, takes no further actions"; the check is not applicable when no \`after\`-match exists.
  The example clauses above illustrate clause shapes only: do not copy their wording into matchers.
- "semanticChecks": [{"quote", "question"}] — clauses only an LLM can judge; the question must be answerable yes/no from the trajectory, and phrased so that "yes" means the clause is SATISFIED. Invert negatively-phrased clauses into positive questions: for "it does not rely on secondary sources alone", ask "did the agent consult the primary source rather than relying on secondary sources alone?", never "did the agent rely on secondary sources alone?".

An event matcher is {"action"?, "actor"?, "contentIncludes"?, "metadata"?: {key: value}}; all set fields must match an event.

VOCABULARY RULE: prefer "action" values and "metadata" keys from the observed vocabulary you are given — those are verified against real traces. When the spec clearly calls for an event the samples do not contain (common for forbidden or rare behaviors that well-behaved samples never exhibit), you may propose a matcher with unobserved vocabulary; it will be flagged for human confirmation during the interview. Only do this when the spec clearly implies the instrumentation records such an event; when detection is genuinely uncertain, use a semantic check instead. Never pad matchers with guessed metadata keys.

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

Observed event vocabulary (from sample trajectories):
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

export interface VocabularySets {
  actions: Set<string>;
  metadataKeys: Set<string>;
}

export function vocabularySets(vocabulary: ActionVocabulary[]): VocabularySets {
  return {
    actions: new Set(vocabulary.map((entry) => entry.action)),
    metadataKeys: new Set(vocabulary.flatMap((entry) => Object.keys(entry.metadataKeys))),
  };
}

function unobservedInPattern(pattern: EventPattern, sets: VocabularySets): string[] {
  const problems: string[] = [];
  for (const matcher of matchers(pattern)) {
    if (matcher.action !== undefined && !sets.actions.has(matcher.action)) {
      problems.push(`action \`${matcher.action}\``);
    }
    for (const key of Object.keys(matcher.metadata ?? {})) {
      if (!sets.metadataKeys.has(key)) problems.push(`metadata key \`${key}\``);
    }
  }
  return [...new Set(problems)];
}

/** Vocabulary a predicate trigger references that no sample event exhibits. */
export function unobservedInTrigger(trigger: Trigger, sets: VocabularySets): string[] {
  return "match" in trigger ? unobservedInPattern(trigger.match, sets) : [];
}

/** Vocabulary a check references that no sample event exhibits. */
export function unobservedInCheck(check: PredicateCheck, sets: VocabularySets): string[] {
  const patterns =
    check.type === "ordering"
      ? [check.first, check.before]
      : check.type === "pairing"
        ? [check.each, check.followedBy]
        : check.after === undefined
          ? [check.match]
          : [check.match, check.after];
  const problems = patterns.flatMap((pattern) => unobservedInPattern(pattern, sets));
  if (check.type === "count" && check.distinctBy?.startsWith("metadata.")) {
    const key = check.distinctBy.slice("metadata.".length);
    if (!sets.metadataKeys.has(key)) problems.push(`metadata key \`${key}\``);
  }
  return [...new Set(problems)];
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

const EVIDENCE_PREFIX = "  evidence: ";
const EVIDENCE_INDENT = " ".repeat(EVIDENCE_PREFIX.length);

function clipContent(content: string, max = 80): string {
  const flat = content.replaceAll(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function writeEvidence(
  deps: InterviewDeps,
  trajectories: AgentTrajectory[],
  pattern: EventPattern,
  opts?: { noMatchIsExpected?: boolean },
): void {
  const found = firstMatch(trajectories, pattern);
  if (found === undefined) {
    deps.write(
      opts?.noMatchIsExpected
        ? `${EVIDENCE_PREFIX}no sample event matches (expected — well-behaved samples should not exhibit a forbidden event)`
        : `${EVIDENCE_PREFIX}no sample event matches`,
    );
    return;
  }
  const { trajectory, event } = found;
  deps.write(`${EVIDENCE_PREFIX}${trajectory.id}/${event.id} (${event.actor} ${event.action})`);
  // Show the event's values for the metadata keys the matcher binds to —
  // the part of the matcher the action name alone can't confirm.
  const matched = matchers(pattern).find((matcher) => matchesEvent(event, matcher));
  for (const key of Object.keys(matched?.metadata ?? {})) {
    deps.write(`${EVIDENCE_INDENT}metadata.${key}: ${JSON.stringify(event.metadata?.[key] ?? "")}`);
  }
  const content = clipContent(event.content);
  if (content.length > 0) deps.write(`${EVIDENCE_INDENT}content: ${JSON.stringify(content)}`);
}

function renderPattern(pattern: EventPattern): string {
  return JSON.stringify(pattern);
}

function writeUnobservedWarning(deps: InterviewDeps, problems: string[]): void {
  if (problems.length === 0) return;
  deps.write(
    `  warning: references ${problems.join(", ")} not observed in any sample trajectory — accept only if your agent's instrumentation emits it`,
  );
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
  sets: VocabularySets,
  deps: InterviewDeps,
): Promise<Trigger> {
  const trigger = meta.trigger;
  deps.write(`\n## ${meta.name}`);
  deps.write(`Trigger: ${trigger.description}`);
  if ("match" in trigger) {
    deps.write(`  match: ${renderPattern(trigger.match)}`);
    writeEvidence(deps, trajectories, trigger.match);
    writeUnobservedWarning(deps, unobservedInTrigger(trigger, sets));
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
  sets: VocabularySets,
  deps: InterviewDeps,
): Promise<{ checks: PredicateCheck[]; demoted: SemanticCheck[] }> {
  const checks: PredicateCheck[] = [];
  const demoted: SemanticCheck[] = [];
  for (const check of meta.checks) {
    deps.write(`Check (${check.type}): "${check.quote}"`);
    if (check.type === "ordering") {
      deps.write(`  first: ${renderPattern(check.first)}`);
      writeEvidence(deps, trajectories, check.first);
      deps.write(`  before: ${renderPattern(check.before)}`);
      writeEvidence(deps, trajectories, check.before);
    } else if (check.type === "pairing") {
      deps.write(`  each: ${renderPattern(check.each)}`);
      writeEvidence(deps, trajectories, check.each);
      deps.write(`  followedBy: ${renderPattern(check.followedBy)}`);
      writeEvidence(deps, trajectories, check.followedBy);
    } else {
      deps.write(`  match: ${renderPattern(check.match)}`);
      writeEvidence(deps, trajectories, check.match, {
        noMatchIsExpected: check.type === "forbidden",
      });
      if (check.after !== undefined) {
        deps.write(`  after: ${renderPattern(check.after)}`);
        writeEvidence(deps, trajectories, check.after);
      }
      if (check.type === "count" && check.distinctBy !== undefined) {
        deps.write(`  distinctBy: ${check.distinctBy}`);
      }
    }
    writeUnobservedWarning(deps, unobservedInCheck(check, sets));
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
  deps.write("Requesting the IR proposal from the model; this can take a minute or two...");

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

  const sets = vocabularySets(vocabulary);
  const namedMetaBehaviors = await interviewNames(proposal, metaBehaviorNames.length > 0, deps);

  const metaBehaviors: MetaBehaviorIr[] = [];
  for (const meta of namedMetaBehaviors) {
    const trigger = await interviewTrigger(meta, input.trajectories, sets, deps);
    const { checks, demoted } = await interviewChecks(meta, input.trajectories, sets, deps);
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
