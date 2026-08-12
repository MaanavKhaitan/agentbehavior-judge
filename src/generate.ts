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
import { clip } from "./text.js";
import type { AgentTrajectory, TrajectoryEvent } from "./trajectory.js";

export interface ActionVocabulary {
  action: string;
  actors: string[];
  /** metadata key -> one example value */
  metadataKeys: Record<string, string>;
  sampleEvent: TrajectoryEvent;
}

export interface SpecSection {
  /** H2 heading text — the meta-behavior name. */
  heading: string;
  /** Normalized section body: the text between this heading and the next H2. */
  body: string;
}

/**
 * Normalize a spec section body so equality comparison (and the `source`
 * field recorded in the IR) is stable across trailing whitespace and blank
 * line runs.
 */
export function normalizeSectionBody(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line === "" && (collapsed.length === 0 || collapsed.at(-1) === "")) continue;
    collapsed.push(line);
  }
  while (collapsed.at(-1) === "") collapsed.pop();
  return collapsed.join("\n");
}

/** Split a spec body into its H2 sections; text before the first H2 is preamble, not a section. */
export function splitSpecSections(behaviorBody: string): SpecSection[] {
  const matches = [...behaviorBody.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)];
  const headings = matches.map((match) => match[1]!.trim());
  const duplicates = headings.filter((name, index) => headings.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(
      `Behavior contains duplicate H2 headings: ${[...new Set(duplicates)].join(", ")}.`,
    );
  }
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1]!.index ?? 0) : behaviorBody.length;
    return {
      heading: headings[index]!,
      body: normalizeSectionBody(behaviorBody.slice(start, end)),
    };
  });
}

export function extractMetaBehaviorNames(behaviorBody: string): string[] {
  return splitSpecSections(behaviorBody).map((section) => section.heading);
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

export const PROPOSAL_SYSTEM_PROMPT = `You compile an Agent Behavior spec into a judge intermediate representation (IR).

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
  return normalizeProposal(parseIr(stringifyYaml(draft)));
}

export function capitalizeFirst(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

// Cosmetic normalization of model-authored prose: predicate trigger
// descriptions and semantic check questions start uppercase. Semantic trigger
// descriptions are left untouched — they feed judge-time question synthesis.
function normalizeProposal(ir: JudgeIr): JudgeIr {
  return {
    ...ir,
    metaBehaviors: ir.metaBehaviors.map((meta) => ({
      ...meta,
      trigger:
        "match" in meta.trigger
          ? { ...meta.trigger, description: capitalizeFirst(meta.trigger.description) }
          : meta.trigger,
      semanticChecks: meta.semanticChecks.map((check) => ({
        ...check,
        question: capitalizeFirst(check.question),
      })),
    })),
  };
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
  /** `prefill` is editable default text placed in the input line (TTY only). */
  ask: (question: string, prefill?: string) => Promise<string>;
  write: (line: string) => void;
}

export interface InterviewInput {
  behaviorName: string;
  behaviorBody: string;
  trajectories: AgentTrajectory[];
}

// ---------------------------------------------------------------------------
// Structured interview steps and answers. The interview driver
// (runProposalInterview) is presentation-agnostic: it walks the proposal and
// asks an InterviewPresenter one step at a time. The readline CLI
// (createTextPresenter) and the --web browser UI are two presenters over the
// same driver, so the demote/drop/edit rules cannot drift between them. The
// deps-based helpers exported below (interviewTrigger/interviewChecks/
// interviewSemanticChecks, reused by update.ts) drive the same review logic
// through a one-off text presenter.
// ---------------------------------------------------------------------------

/** Which slot of a check a pattern occupies, for labeling evidence. */
export type PatternRole = "match" | "first" | "before" | "each" | "followedBy" | "after";

export interface EvidenceSample {
  trajectoryId: string;
  event: TrajectoryEvent;
  /** The matcher within the pattern that the sample event satisfied. */
  matcher: EventMatcher;
}

export interface PatternEvidence {
  role: PatternRole;
  pattern: EventPattern;
  /** First matching event across the sample trajectories, if any. */
  sample?: EvidenceSample;
  /** True when no match is the healthy outcome (forbidden checks). */
  noMatchIsExpected: boolean;
}

export interface StepPosition {
  metaIndex: number;
  metaCount: number;
  itemIndex?: number;
  itemCount?: number;
}

export interface NameStep {
  kind: "name";
  name: string;
  index: number;
  count: number;
}

export interface TriggerStep {
  kind: "trigger";
  metaName: string;
  trigger: Trigger;
  /** Present only for predicate triggers. */
  evidence?: PatternEvidence;
  unobserved: string[];
  position: StepPosition;
}

export interface CheckStep {
  kind: "check";
  metaName: string;
  check: PredicateCheck;
  /** One entry per pattern slot, in the order the slots read. */
  evidence: PatternEvidence[];
  unobserved: string[];
  position: StepPosition;
}

export interface SemanticCheckStep {
  kind: "semanticCheck";
  metaName: string;
  check: SemanticCheck;
  /** True when the check was demoted from a predicate earlier in the interview. */
  demoted: boolean;
  position: StepPosition;
}

export interface ConfirmStep {
  kind: "confirm";
  ir: JudgeIr;
  yaml: string;
}

export type NameAnswer = { kind: "keep" } | { kind: "rename"; name: string } | { kind: "drop" };

export type TriggerAnswer =
  | { kind: "accept" }
  | { kind: "forceSemantic" }
  | { kind: "edit"; description: string };

export type CheckAnswer = { kind: "accept" } | { kind: "demote" } | { kind: "drop" };

export type SemanticCheckAnswer =
  | { kind: "accept" }
  | { kind: "edit"; question: string }
  | { kind: "drop" };

export type InterviewNote =
  | { kind: "vocabulary"; actionCount: number; trajectoryCount: number }
  | { kind: "requestingProposal" }
  | { kind: "namesIntro" }
  | { kind: "metaHeader"; name: string }
  | { kind: "metaDropped"; name: string };

export interface InterviewPresenter {
  note: (note: InterviewNote) => void;
  askName: (step: NameStep) => Promise<NameAnswer>;
  askTrigger: (step: TriggerStep) => Promise<TriggerAnswer>;
  askCheck: (step: CheckStep) => Promise<CheckAnswer>;
  askSemanticCheck: (step: SemanticCheckStep) => Promise<SemanticCheckAnswer>;
  confirm: (step: ConfirmStep) => Promise<boolean>;
}

export interface InterviewContext {
  behaviorName: string;
  hasHeadings: boolean;
  trajectories: AgentTrajectory[];
  sets: VocabularySets;
  /** H2 sections of the spec; each kept meta records its section body as `source`. */
  sections: SpecSection[];
}

export interface PreparedInterview {
  proposal: JudgeIr;
  context: InterviewContext;
}

export function renderNote(note: InterviewNote): string {
  switch (note.kind) {
    case "vocabulary":
      return `Observed vocabulary: ${note.actionCount} action(s) across ${note.trajectoryCount} trajectory(ies).`;
    case "requestingProposal":
      return "Requesting the IR proposal from the model; this can take a minute or two...";
    case "namesIntro":
      return "The spec has no H2 headings; confirm the proposed meta-behavior names.";
    case "metaHeader":
      return `\n## ${note.name}`;
    case "metaDropped":
      return `note: "${note.name}" has no checks left; dropping it.`;
  }
}

/**
 * Extract vocabulary and fetch the one proposal LLM call. Separated from the
 * interview loop so the web UI can re-run the (deterministic) interview for
 * back-navigation without re-asking the model.
 */
export async function prepareInterview(
  input: InterviewInput,
  complete: JudgeCompletion,
  note?: (note: InterviewNote) => void,
): Promise<PreparedInterview> {
  if (input.trajectories.length === 0) {
    throw new Error(
      "generate needs at least one sample trajectory JSON to bind predicates to your event vocabulary.",
    );
  }

  const sections = splitSpecSections(input.behaviorBody);
  const metaBehaviorNames = sections.map((section) => section.heading);
  const vocabulary = extractVocabulary(input.trajectories);
  note?.({
    kind: "vocabulary",
    actionCount: vocabulary.length,
    trajectoryCount: input.trajectories.length,
  });
  note?.({ kind: "requestingProposal" });

  const proposal = await completeJsonWithRetry(
    complete,
    buildProposalMessages({
      behaviorName: input.behaviorName,
      behaviorBody: input.behaviorBody,
      metaBehaviorNames,
      vocabulary,
    }),
    (response) => parseProposal(response, input.behaviorName),
  );

  return {
    proposal,
    context: {
      behaviorName: input.behaviorName,
      hasHeadings: sections.length > 0,
      trajectories: input.trajectories,
      sets: vocabularySets(vocabulary),
      sections,
    },
  };
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

function patternEvidence(
  trajectories: AgentTrajectory[],
  role: PatternRole,
  pattern: EventPattern,
  noMatchIsExpected = false,
): PatternEvidence {
  const found = firstMatch(trajectories, pattern);
  if (found === undefined) return { role, pattern, noMatchIsExpected };
  const matcher = matchers(pattern).find((entry) => matchesEvent(found.event, entry)) ?? {};
  return {
    role,
    pattern,
    noMatchIsExpected,
    sample: { trajectoryId: found.trajectory.id, event: found.event, matcher },
  };
}

function checkEvidence(check: PredicateCheck, trajectories: AgentTrajectory[]): PatternEvidence[] {
  if (check.type === "ordering") {
    return [
      patternEvidence(trajectories, "first", check.first),
      patternEvidence(trajectories, "before", check.before),
    ];
  }
  if (check.type === "pairing") {
    return [
      patternEvidence(trajectories, "each", check.each),
      patternEvidence(trajectories, "followedBy", check.followedBy),
    ];
  }
  const entries = [patternEvidence(trajectories, "match", check.match, check.type === "forbidden")];
  if (check.after !== undefined) entries.push(patternEvidence(trajectories, "after", check.after));
  return entries;
}

// ---------------------------------------------------------------------------
// Text rendering primitives, shared by the text presenter and update.ts.
// ---------------------------------------------------------------------------

const EVIDENCE_PREFIX = "  evidence: ";
const EVIDENCE_INDENT = " ".repeat(EVIDENCE_PREFIX.length);
const EVIDENCE_CONTENT_MAX = 80;

export function renderPattern(pattern: EventPattern): string {
  return JSON.stringify(pattern);
}

function writeEvidenceLines(deps: Pick<InterviewDeps, "write">, entry: PatternEvidence): void {
  if (entry.sample === undefined) {
    deps.write(
      entry.noMatchIsExpected
        ? `${EVIDENCE_PREFIX}no sample event matches (expected — well-behaved samples should not exhibit a forbidden event)`
        : `${EVIDENCE_PREFIX}no sample event matches`,
    );
    return;
  }
  const { trajectoryId, event, matcher } = entry.sample;
  deps.write(`${EVIDENCE_PREFIX}${trajectoryId}/${event.id} (${event.actor} ${event.action})`);
  // Show the event's values for the metadata keys the matcher binds to —
  // the part of the matcher the action name alone can't confirm.
  for (const key of Object.keys(matcher.metadata ?? {})) {
    deps.write(`${EVIDENCE_INDENT}metadata.${key}: ${JSON.stringify(event.metadata?.[key] ?? "")}`);
  }
  const content = clip(event.content, EVIDENCE_CONTENT_MAX);
  if (content.length > 0) deps.write(`${EVIDENCE_INDENT}content: ${JSON.stringify(content)}`);
}

export function writeEvidence(
  deps: Pick<InterviewDeps, "write">,
  trajectories: AgentTrajectory[],
  pattern: EventPattern,
  opts?: { noMatchIsExpected?: boolean },
): void {
  writeEvidenceLines(
    deps,
    patternEvidence(trajectories, "match", pattern, opts?.noMatchIsExpected ?? false),
  );
}

export function writeUnobservedWarning(
  deps: Pick<InterviewDeps, "write">,
  problems: string[],
): void {
  if (problems.length === 0) return;
  deps.write(
    `  warning: references ${problems.join(", ")} not observed in any sample trajectory — accept only if your agent's instrumentation emits it`,
  );
}

export async function askChoice(
  deps: Pick<InterviewDeps, "ask" | "write">,
  prompt: string,
  choices: string[],
): Promise<string> {
  for (;;) {
    const answer = (await deps.ask(`${prompt} `)).trim().toLowerCase();
    if (answer === "" && choices.length > 0) return choices[0]!;
    if (choices.includes(answer)) return answer;
    deps.write(`Please answer one of: ${choices.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Per-item review: build the structured step, ask the presenter, apply the
// answer. Used by the full-interview driver with real positions, and by the
// exported deps-based helpers below with a one-off text presenter.
// ---------------------------------------------------------------------------

async function reviewTrigger(
  trigger: Trigger,
  trajectories: AgentTrajectory[],
  sets: VocabularySets,
  presenter: InterviewPresenter,
  metaName: string,
  position: StepPosition,
): Promise<Trigger> {
  const step: TriggerStep = {
    kind: "trigger",
    metaName,
    trigger,
    unobserved: unobservedInTrigger(trigger, sets),
    position,
    ...("match" in trigger
      ? { evidence: patternEvidence(trajectories, "match", trigger.match) }
      : {}),
  };
  const answer = await presenter.askTrigger(step);

  if ("match" in trigger) {
    if (answer.kind === "forceSemantic") {
      return { description: trigger.description, semantic: true };
    }
    if (answer.kind === "edit") {
      const description = answer.description.trim();
      return description.length > 0
        ? { ...trigger, description: capitalizeFirst(description) }
        : trigger;
    }
    return trigger;
  }

  if (answer.kind === "edit") {
    const description = answer.description.trim();
    return description.length > 0 ? { description, semantic: true } : trigger;
  }
  return trigger;
}

async function reviewChecks(
  proposedChecks: PredicateCheck[],
  trajectories: AgentTrajectory[],
  sets: VocabularySets,
  presenter: InterviewPresenter,
  metaName: string,
  position: StepPosition,
): Promise<{ checks: PredicateCheck[]; demoted: SemanticCheck[] }> {
  const checks: PredicateCheck[] = [];
  const demoted: SemanticCheck[] = [];
  for (const [index, check] of proposedChecks.entries()) {
    const answer = await presenter.askCheck({
      kind: "check",
      metaName,
      check,
      evidence: checkEvidence(check, trajectories),
      unobserved: unobservedInCheck(check, sets),
      position: { ...position, itemIndex: index, itemCount: proposedChecks.length },
    });
    if (answer.kind === "accept") checks.push(check);
    if (answer.kind === "demote") {
      demoted.push({
        quote: check.quote,
        question: `Does the agent's conduct satisfy this clause: "${check.quote}"?`,
      });
    }
  }
  return { checks, demoted };
}

async function reviewSemanticChecks(
  candidates: Array<{ check: SemanticCheck; demoted: boolean }>,
  presenter: InterviewPresenter,
  metaName: string,
  position: StepPosition,
): Promise<SemanticCheck[]> {
  const kept: SemanticCheck[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const answer = await presenter.askSemanticCheck({
      kind: "semanticCheck",
      metaName,
      check: candidate.check,
      demoted: candidate.demoted,
      position: { ...position, itemIndex: index, itemCount: candidates.length },
    });
    if (answer.kind === "drop") continue;
    if (answer.kind === "edit") {
      const question = answer.question.trim();
      kept.push(
        question.length > 0
          ? { ...candidate.check, question: capitalizeFirst(question) }
          : candidate.check,
      );
    } else {
      kept.push(candidate.check);
    }
  }
  return kept;
}

const STANDALONE_POSITION: StepPosition = { metaIndex: 0, metaCount: 1 };

/** Deps-based per-trigger review (readline rendering); update.ts reuses it. */
export async function interviewTrigger(
  trigger: Trigger,
  trajectories: AgentTrajectory[],
  sets: VocabularySets,
  deps: InterviewDeps,
): Promise<Trigger> {
  return reviewTrigger(
    trigger,
    trajectories,
    sets,
    createTextPresenter(deps),
    "",
    STANDALONE_POSITION,
  );
}

/** Deps-based per-check review (readline rendering); update.ts reuses it. */
export async function interviewChecks(
  proposedChecks: PredicateCheck[],
  trajectories: AgentTrajectory[],
  sets: VocabularySets,
  deps: InterviewDeps,
): Promise<{ checks: PredicateCheck[]; demoted: SemanticCheck[] }> {
  return reviewChecks(
    proposedChecks,
    trajectories,
    sets,
    createTextPresenter(deps),
    "",
    STANDALONE_POSITION,
  );
}

/** Deps-based semantic-check review (readline rendering); update.ts reuses it. */
export async function interviewSemanticChecks(
  semanticChecks: SemanticCheck[],
  deps: InterviewDeps,
): Promise<SemanticCheck[]> {
  return reviewSemanticChecks(
    semanticChecks.map((check) => ({ check, demoted: false })),
    createTextPresenter(deps),
    "",
    STANDALONE_POSITION,
  );
}

async function namePhase(
  proposal: JudgeIr,
  context: InterviewContext,
  presenter: InterviewPresenter,
): Promise<MetaBehaviorIr[]> {
  if (context.hasHeadings) return proposal.metaBehaviors;

  presenter.note({ kind: "namesIntro" });
  const kept: MetaBehaviorIr[] = [];
  for (const [index, meta] of proposal.metaBehaviors.entries()) {
    const answer = await presenter.askName({
      kind: "name",
      name: meta.name,
      index,
      count: proposal.metaBehaviors.length,
    });
    if (answer.kind === "drop") continue;
    if (answer.kind === "rename") {
      const name = answer.name.trim();
      kept.push(name.length > 0 ? { ...meta, name } : meta);
    } else {
      kept.push(meta);
    }
  }
  return kept;
}

/**
 * Walk a fetched proposal through the presenter, one step per trigger/check/
 * semantic check. Deterministic given (proposal, answers): no LLM calls, no
 * IO — which is what lets the web UI replay recorded answers to go back.
 */
export async function runProposalInterview(
  proposal: JudgeIr,
  context: InterviewContext,
  presenter: InterviewPresenter,
): Promise<JudgeIr | undefined> {
  const named = await namePhase(proposal, context, presenter);
  const sectionByName = new Map(context.sections.map((section) => [section.heading, section.body]));

  const metaBehaviors: MetaBehaviorIr[] = [];
  for (const [metaIndex, meta] of named.entries()) {
    const position: StepPosition = { metaIndex, metaCount: named.length };
    presenter.note({ kind: "metaHeader", name: meta.name });
    const trigger = await reviewTrigger(
      meta.trigger,
      context.trajectories,
      context.sets,
      presenter,
      meta.name,
      position,
    );
    const { checks, demoted } = await reviewChecks(
      meta.checks,
      context.trajectories,
      context.sets,
      presenter,
      meta.name,
      position,
    );
    const semanticChecks = await reviewSemanticChecks(
      [
        ...meta.semanticChecks.map((check) => ({ check, demoted: false })),
        ...demoted.map((check) => ({ check, demoted: true })),
      ],
      presenter,
      meta.name,
      position,
    );
    if (checks.length === 0 && semanticChecks.length === 0) {
      presenter.note({ kind: "metaDropped", name: meta.name });
      continue;
    }
    const kept: MetaBehaviorIr = { name: meta.name, trigger, checks, semanticChecks };
    const source = sectionByName.get(meta.name);
    if (source !== undefined && source.length > 0) kept.source = source;
    metaBehaviors.push(kept);
  }

  if (metaBehaviors.length === 0) {
    throw new Error("No meta-behaviors left after the interview; nothing to write.");
  }

  const ir: JudgeIr = { version: 1, behavior: context.behaviorName, metaBehaviors };
  const confirmed = await presenter.confirm({ kind: "confirm", ir, yaml: serializeIr(ir) });
  return confirmed ? ir : undefined;
}

/**
 * The readline presentation of the interview: single-letter answers, evidence
 * lines, prefillable edit prompts. Output is the CLI contract generate.test.ts
 * scripts against.
 */
export function createTextPresenter(
  deps: Pick<InterviewDeps, "ask" | "write">,
): InterviewPresenter {
  return {
    note: (note) => {
      deps.write(renderNote(note));
    },

    askName: async (step) => {
      const answer = await askChoice(
        deps,
        `Meta-behavior "${step.name}" — [y] keep / [e] rename / [d] drop`,
        ["y", "e", "d"],
      );
      if (answer === "d") return { kind: "drop" };
      if (answer === "e") {
        return { kind: "rename", name: (await deps.ask("New name: ", step.name)).trim() };
      }
      return { kind: "keep" };
    },

    askTrigger: async (step) => {
      deps.write(`Trigger: ${step.trigger.description}`);
      if ("match" in step.trigger) {
        deps.write(`  match: ${renderPattern(step.trigger.match)}`);
        if (step.evidence !== undefined) writeEvidenceLines(deps, step.evidence);
        writeUnobservedWarning(deps, step.unobserved);
        const answer = await askChoice(
          deps,
          "[y] accept / [s] force semantic / [e] edit description",
          ["y", "s", "e"],
        );
        if (answer === "s") return { kind: "forceSemantic" };
        if (answer === "e") {
          return {
            kind: "edit",
            description: (
              await deps.ask("New trigger description: ", step.trigger.description)
            ).trim(),
          };
        }
        return { kind: "accept" };
      }

      deps.write("  (semantic trigger: judged by one scoped LLM call)");
      const answer = await askChoice(deps, "[y] accept / [e] edit description", ["y", "e"]);
      if (answer === "e") {
        return {
          kind: "edit",
          description: (
            await deps.ask("New trigger description: ", step.trigger.description)
          ).trim(),
        };
      }
      return { kind: "accept" };
    },

    askCheck: async (step) => {
      deps.write(`Check (${step.check.type}): "${step.check.quote}"`);
      for (const entry of step.evidence) {
        deps.write(`  ${entry.role}: ${renderPattern(entry.pattern)}`);
        writeEvidenceLines(deps, entry);
      }
      if (step.check.type === "count" && step.check.distinctBy !== undefined) {
        deps.write(`  distinctBy: ${step.check.distinctBy}`);
      }
      writeUnobservedWarning(deps, step.unobserved);
      const answer = await askChoice(deps, "[y] accept / [s] demote to semantic / [d] drop", [
        "y",
        "s",
        "d",
      ]);
      if (answer === "s") return { kind: "demote" };
      if (answer === "d") return { kind: "drop" };
      return { kind: "accept" };
    },

    askSemanticCheck: async (step) => {
      deps.write(`Semantic check: "${step.check.quote}"`);
      deps.write(`  question: ${step.check.question}`);
      const answer = await askChoice(deps, "[y] accept / [e] retype question / [d] drop", [
        "y",
        "e",
        "d",
      ]);
      if (answer === "d") return { kind: "drop" };
      if (answer === "e") {
        return {
          kind: "edit",
          question: (await deps.ask("New question: ", step.check.question)).trim(),
        };
      }
      return { kind: "accept" };
    },

    confirm: async (step) => {
      deps.write("\nGenerated judge IR:\n");
      deps.write(step.yaml);
      const answer = await askChoice(deps, "Write this IR? [y] yes / [n] no", ["y", "n"]);
      return answer === "y";
    },
  };
}

/**
 * Run the generate interview. Returns the confirmed IR, or undefined when the
 * user declines to write it.
 */
export async function runInterview(
  input: InterviewInput,
  deps: InterviewDeps,
): Promise<JudgeIr | undefined> {
  const presenter = createTextPresenter(deps);
  const prepared = await prepareInterview(input, deps.complete, (note) => {
    presenter.note(note);
  });
  return runProposalInterview(prepared.proposal, prepared.context, presenter);
}
