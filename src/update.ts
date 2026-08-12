import { stringify as stringifyYaml } from "yaml";

import {
  askChoice,
  capitalizeFirst,
  createTextPresenter,
  extractVocabulary,
  parseProposal,
  patternEvidence,
  PROPOSAL_SYSTEM_PROMPT,
  renderNote,
  renderPattern,
  reviewChecks,
  reviewSemanticChecks,
  reviewTrigger,
  splitSpecSections,
  unobservedInTrigger,
  vocabularySets,
  writeEvidenceLines,
  writeUnobservedWarning,
  type ActionVocabulary,
  type InterviewDeps,
  type InterviewNote,
  type InterviewPresenter,
  type PatternEvidence,
  type SpecSection,
  type StepPosition,
  type VocabularySets,
} from "./generate.js";
import {
  completeJsonWithRetry,
  isRecord,
  parseJsonObject,
  requireNonEmptyString,
  type GatewayMessage,
  type JudgeCompletion,
} from "./gateway.js";
import {
  serializeIr,
  type JudgeIr,
  type MetaBehaviorIr,
  type PredicateCheck,
  type SemanticCheck,
  type Trigger,
} from "./ir.js";
import type { AgentTrajectory } from "./trajectory.js";

// ---------------------------------------------------------------------------
// Update plan: map existing meta-behaviors onto the edited spec's sections.
// All change detection is deterministic and code-side; the LLM is never asked
// what changed.
// ---------------------------------------------------------------------------

export type UpdateEntry =
  | { kind: "unchanged"; meta: MetaBehaviorIr; section: SpecSection }
  | { kind: "changed"; meta: MetaBehaviorIr; section: SpecSection }
  | { kind: "added"; section: SpecSection };

export interface UpdatePlan {
  /** One entry per current-spec section, in spec order. */
  entries: UpdateEntry[];
  /** Existing meta-behaviors whose sections no longer appear in the spec. */
  removed: MetaBehaviorIr[];
}

export function planUpdate(existing: JudgeIr, sections: SpecSection[]): UpdatePlan {
  const byName = new Map(existing.metaBehaviors.map((meta) => [meta.name, meta]));
  const headings = new Set(sections.map((section) => section.heading));
  const entries: UpdateEntry[] = sections.map((section) => {
    const meta = byName.get(section.heading);
    if (meta === undefined) return { kind: "added", section };
    // A meta without a recorded source cannot be verified unchanged; treat its
    // section as changed so it gets the full delta review.
    const kind: "unchanged" | "changed" = meta.source === section.body ? "unchanged" : "changed";
    return { kind, meta, section };
  });
  return {
    entries,
    removed: existing.metaBehaviors.filter((meta) => !headings.has(meta.name)),
  };
}

// ---------------------------------------------------------------------------
// Section delta: within a changed section, existing clauses whose quoted
// sentences survive verbatim are carried from the existing IR (proposal drift
// for those quotes is discarded — the human already approved them); clauses
// whose quotes vanished are dropped; proposal clauses with new quotes are the
// deltas the interview asks about.
// ---------------------------------------------------------------------------

function flattenWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

export function quoteInSection(quote: string, sectionBody: string): boolean {
  return flattenWhitespace(sectionBody).includes(flattenWhitespace(quote));
}

/**
 * Predicate triggers compare by match pattern only (the description is
 * cosmetic there); semantic trigger descriptions feed judge-time question
 * synthesis, so they must match too.
 */
function triggerCarried(existing: Trigger, proposed: Trigger): boolean {
  if ("match" in existing && "match" in proposed) {
    return JSON.stringify(existing.match) === JSON.stringify(proposed.match);
  }
  if ("match" in existing || "match" in proposed) return false;
  return existing.description === proposed.description;
}

export interface SectionDelta {
  triggerCarried: boolean;
  carriedChecks: PredicateCheck[];
  droppedChecks: PredicateCheck[];
  newChecks: PredicateCheck[];
  carriedSemanticChecks: SemanticCheck[];
  droppedSemanticChecks: SemanticCheck[];
  newSemanticChecks: SemanticCheck[];
}

export function computeSectionDelta(
  existing: MetaBehaviorIr,
  proposed: MetaBehaviorIr,
  sectionBody: string,
): SectionDelta {
  const carriedChecks = existing.checks.filter((check) => quoteInSection(check.quote, sectionBody));
  const carriedCheckQuotes = new Set(carriedChecks.map((check) => flattenWhitespace(check.quote)));
  const carriedSemanticChecks = existing.semanticChecks.filter((check) =>
    quoteInSection(check.quote, sectionBody),
  );
  const carriedSemanticQuotes = new Set(
    carriedSemanticChecks.map((check) => flattenWhitespace(check.quote)),
  );
  return {
    triggerCarried: triggerCarried(existing.trigger, proposed.trigger),
    carriedChecks,
    droppedChecks: existing.checks.filter((check) => !quoteInSection(check.quote, sectionBody)),
    newChecks: proposed.checks.filter(
      (check) => !carriedCheckQuotes.has(flattenWhitespace(check.quote)),
    ),
    carriedSemanticChecks,
    droppedSemanticChecks: existing.semanticChecks.filter(
      (check) => !quoteInSection(check.quote, sectionBody),
    ),
    newSemanticChecks: proposed.semanticChecks.filter(
      (check) => !carriedSemanticQuotes.has(flattenWhitespace(check.quote)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Update proposal: one scoped LLM call covering only the changed and added
// sections, with the previous meta IR as context for changed ones.
// ---------------------------------------------------------------------------

export interface UpdateTarget {
  section: SpecSection;
  previous?: MetaBehaviorIr;
}

const UPDATE_SYSTEM_SUFFIX = `

UPDATE MODE: the spec was edited after a judge IR for it was already reviewed by a human. Propose meta-behaviors ONLY for the sections listed in the request, one per section, using the exact heading as the name. For a section that comes with its previous meta-behavior IR, revise it minimally: keep clauses whose quoted sentences are unchanged exactly as they are (same quote, same matchers, same questions), and add, remove, or change only what the edit requires. Every quote must be a verbatim excerpt of that section's current text.`;

function metaWithoutSource(meta: MetaBehaviorIr): Omit<MetaBehaviorIr, "source"> {
  return {
    name: meta.name,
    trigger: meta.trigger,
    checks: meta.checks,
    semanticChecks: meta.semanticChecks,
  };
}

export function buildUpdateProposalMessages(input: {
  behaviorName: string;
  behaviorBody: string;
  targets: UpdateTarget[];
  vocabulary: ActionVocabulary[];
}): GatewayMessage[] {
  const sections = input.targets
    .map((target) => {
      const text = `Section "${target.section.heading}"${target.previous === undefined ? " (new)" : " (edited)"}:\n${target.section.body}`;
      if (target.previous === undefined) return text;
      return `${text}\n\nPrevious meta-behavior IR for "${target.section.heading}":\n${stringifyYaml(metaWithoutSource(target.previous))}`;
    })
    .join("\n\n");
  const vocabulary = input.vocabulary.map((entry) => ({
    action: entry.action,
    actors: entry.actors,
    metadataKeys: entry.metadataKeys,
    sampleEvent: entry.sampleEvent,
  }));
  return [
    { role: "system", content: PROPOSAL_SYSTEM_PROMPT + UPDATE_SYSTEM_SUFFIX },
    {
      role: "user",
      content: `Behavior name: ${input.behaviorName}

Full behavior body (context only — propose nothing for sections not listed below):
${input.behaviorBody}

Propose meta-behaviors for exactly these sections (exact headings as names):
${JSON.stringify(input.targets.map((target) => target.section.heading))}

${sections}

Observed event vocabulary (from sample trajectories):
${JSON.stringify(vocabulary, null, 2)}`,
    },
  ];
}

export function parseUpdateProposal(
  response: string,
  behaviorName: string,
  targets: UpdateTarget[],
): Map<string, MetaBehaviorIr> {
  const ir = parseProposal(response, behaviorName);
  const expected = new Map(targets.map((target) => [target.section.heading, target.section.body]));
  const got = ir.metaBehaviors.map((meta) => meta.name);
  const missing = [...expected.keys()].filter((name) => !got.includes(name));
  const extra = got.filter((name) => !expected.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      "Update proposal must contain exactly the requested meta-behaviors." +
        (missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "") +
        (extra.length > 0 ? ` Unexpected: ${extra.join(", ")}.` : ""),
    );
  }
  for (const meta of ir.metaBehaviors) {
    const body = expected.get(meta.name)!;
    for (const check of [...meta.checks, ...meta.semanticChecks]) {
      if (!quoteInSection(check.quote, body)) {
        throw new Error(
          `Quote "${check.quote}" in meta-behavior "${meta.name}" is not a verbatim excerpt of that section's current text.`,
        );
      }
    }
  }
  return new Map(ir.metaBehaviors.map((meta) => [meta.name, meta]));
}

// ---------------------------------------------------------------------------
// Triage: one scoped LLM call per changed section that decides, for each
// mechanically-carried clause, whether the edit could shift its meaning.
// Demote-only by construction: a "re_ask" verdict moves a clause from the
// batch confirm to an individual question; nothing the model says can shrink
// the review below the code-computed carried set or alter any clause.
// ---------------------------------------------------------------------------

const TRIAGE_SYSTEM_PROMPT = `A section of an Agent Behavior spec was edited after its judge clauses were reviewed by a human. Clauses whose quoted sentences survive the edit verbatim are carried over without re-review. Your only job: for each carried clause, decide whether the edit could change how the clause should be interpreted or matched — for example, the edit redefines a term the clause's matcher or question relies on, or changes when the section applies. Do not judge whether a clause is well designed; judge only whether this edit affects it.

Return JSON only:
{"items": [{"id": "<id>", "verdict": "unaffected" | "re_ask", "reason": "<one sentence>"}]}
Include every listed id exactly once. Use "re_ask" whenever you are unsure. Write each reason as a plain declarative sentence stating what the edit changed and what the clause now needs (e.g. "the edit redefines what counts as a primary source, so this matcher needs updating"); never hedge with "may", "might", or "could" — the re_ask verdict itself already conveys that a human decides.`;

export interface TriageItem {
  id: string;
  description: string;
}

export interface TriageVerdict {
  reAsk: boolean;
  reason: string;
}

export function buildTriageMessages(input: {
  metaName: string;
  previousSection: string;
  currentSection: string;
  items: TriageItem[];
}): GatewayMessage[] {
  return [
    { role: "system", content: TRIAGE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Meta-behavior: ${input.metaName}

Section text before the edit:
${input.previousSection}

Section text after the edit:
${input.currentSection}

Carried clauses:
${JSON.stringify(input.items, null, 2)}`,
    },
  ];
}

export function parseTriageResult(response: string, ids: string[]): Map<string, TriageVerdict> {
  const parsed = parseJsonObject(response);
  if (!Array.isArray(parsed.items)) {
    throw new Error("Triage response field items must be an array.");
  }
  const result = new Map<string, TriageVerdict>();
  for (const [index, item] of parsed.items.entries()) {
    if (!isRecord(item)) throw new Error(`Triage response items[${index}] must be an object.`);
    const id = requireNonEmptyString(item.id, `items[${index}].id`);
    if (!ids.includes(id)) {
      throw new Error(`Triage response items[${index}].id "${id}" is not a listed clause id.`);
    }
    if (result.has(id)) {
      throw new Error(`Triage response items[${index}].id "${id}" appears more than once.`);
    }
    if (item.verdict !== "unaffected" && item.verdict !== "re_ask") {
      throw new Error(`Triage response items[${index}].verdict must be "unaffected" or "re_ask".`);
    }
    result.set(id, {
      reAsk: item.verdict === "re_ask",
      reason: requireNonEmptyString(item.reason, `items[${index}].reason`),
    });
  }
  const missingIds = ids.filter((id) => !result.has(id));
  if (missingIds.length > 0) {
    throw new Error(`Triage response is missing ids: ${missingIds.join(", ")}.`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Structured update steps and answers. Like generate.ts, the update interview
// splits into prepareUpdate (every LLM call: the shared proposal plus one
// triage per changed section) and runUpdateProposalInterview (a deterministic
// driver speaking to an UpdatePresenter) — which is what lets the --web UI
// replay recorded answers for back-navigation without re-asking the model.
// The two update-only interactions get their own step kinds; everything else
// reuses the generate steps (with `reAskReason` set on triage-flagged ones).
// ---------------------------------------------------------------------------

export interface UpdateInput {
  behaviorName: string;
  behaviorBody: string;
  existing: JudgeIr;
  trajectories: AgentTrajectory[];
}

/** A clause carried over because its quoted sentence survived the spec edit. */
export type CarriedClause =
  | { kind: "trigger"; trigger: Trigger }
  | { kind: "check"; check: PredicateCheck }
  | { kind: "semantic"; check: SemanticCheck };

/** A carried clause plus the stable id triage verdicts key on. */
export type CarriedItem = CarriedClause & { id: string };

export interface ChangedTriggerStep {
  kind: "changedTrigger";
  metaName: string;
  previous: Trigger;
  proposed: Trigger;
  /** Present only when the proposed trigger is a predicate. */
  evidence?: PatternEvidence;
  unobserved: string[];
  position: StepPosition;
}

export type ChangedTriggerAnswer =
  | { kind: "accept" }
  | { kind: "keepPrevious" }
  | { kind: "forceSemantic" }
  | { kind: "edit"; description: string };

export interface CarriedBatchStep {
  kind: "carriedBatch";
  metaName: string;
  /** Carried clauses triage left unflagged, in trigger/checks/semantics order. */
  items: CarriedClause[];
  position: StepPosition;
}

export type CarriedBatchAnswer = { kind: "keep" } | { kind: "review" };

export type UpdateNote =
  | InterviewNote
  | { kind: "planSummary"; unchanged: number; changed: number; added: number; removed: number }
  | { kind: "metaRemoved"; name: string }
  | { kind: "requestingUpdateProposal" }
  | { kind: "sectionHeader"; name: string; status: "unchanged" | "changed" | "added" }
  | { kind: "clauseDropped"; label: string; quote: string };

export interface UpdatePresenter extends InterviewPresenter {
  note: (note: UpdateNote) => void;
  askChangedTrigger: (step: ChangedTriggerStep) => Promise<ChangedTriggerAnswer>;
  askCarriedBatch: (step: CarriedBatchStep) => Promise<CarriedBatchAnswer>;
}

const SECTION_STATUS_LABEL = {
  unchanged: "unchanged; carried over.",
  changed: "section changed.",
  added: "new section.",
} as const;

export function renderUpdateNote(note: UpdateNote): string {
  switch (note.kind) {
    case "planSummary":
      return `Spec sections: ${note.unchanged} unchanged, ${note.changed} changed, ${note.added} added; ${note.removed} meta-behavior(s) removed.`;
    case "metaRemoved":
      return `note: "${note.name}" removed — its section no longer appears in the spec.`;
    case "requestingUpdateProposal":
      return "Requesting revised meta-behaviors from the model; this can take a minute or two...";
    case "sectionHeader":
      return `\n## ${note.name} — ${SECTION_STATUS_LABEL[note.status]}`;
    case "clauseDropped":
      return `note: dropped ${note.label} "${note.quote}" — its quoted sentence no longer appears in the section.`;
    default:
      return renderNote(note);
  }
}

function triggerLine(trigger: Trigger): string {
  return "match" in trigger
    ? `${trigger.description} match: ${renderPattern(trigger.match)}`
    : `${trigger.description} (semantic)`;
}

function carriedClauseLabel(clause: CarriedClause): string {
  if (clause.kind === "trigger") return `trigger: ${triggerLine(clause.trigger)}`;
  if (clause.kind === "check") return `${clause.check.type}: "${clause.check.quote}"`;
  return `semantic: "${clause.check.quote}"`;
}

function carriedItemDescription(item: CarriedItem): string {
  if (item.kind === "trigger") return `trigger ${JSON.stringify(item.trigger)}`;
  if (item.kind === "check") return `predicate check ${JSON.stringify(item.check)}`;
  return `semantic check ${JSON.stringify(item.check)}`;
}

function carriedClause(item: CarriedItem): CarriedClause {
  if (item.kind === "trigger") return { kind: "trigger", trigger: item.trigger };
  if (item.kind === "check") return { kind: "check", check: item.check };
  return { kind: "semantic", check: item.check };
}

export interface PreparedChangedSection {
  delta: SectionDelta;
  /** Carried clauses in trigger/checks/semantics order; ids key the triage map. */
  items: CarriedItem[];
  triage: Map<string, TriageVerdict>;
}

export interface PreparedUpdate {
  behaviorName: string;
  trajectories: AgentTrajectory[];
  sets: VocabularySets;
  plan: UpdatePlan;
  /** Proposed meta-behaviors for changed and added sections, by heading. */
  proposals: Map<string, MetaBehaviorIr>;
  /** Delta, carried items, and triage verdicts per changed-section heading. */
  changed: Map<string, PreparedChangedSection>;
}

/**
 * Validate the input, plan the update, and make every LLM call the interview
 * needs: one shared proposal covering all changed+added sections, then one
 * demote-only triage call per changed section with carried clauses (a meta
 * without a recorded `source` gets every carried clause re-asked instead — the
 * safe ceiling — with no LLM call). Separated from the interview loop so the
 * web UI can re-run the (deterministic) interview for back-navigation without
 * re-asking the model.
 */
export async function prepareUpdate(
  input: UpdateInput,
  complete: JudgeCompletion,
  note?: (note: UpdateNote) => void,
): Promise<PreparedUpdate> {
  if (input.trajectories.length === 0) {
    throw new Error(
      "update needs at least one sample trajectory JSON to bind predicates to your event vocabulary.",
    );
  }
  const sections = splitSpecSections(input.behaviorBody);
  if (sections.length === 0) {
    throw new Error(
      "update requires a spec with H2 sections to map onto the existing IR; for a spec without headings, run generate without --update.",
    );
  }

  const plan = planUpdate(input.existing, sections);
  const count = (kind: UpdateEntry["kind"]) =>
    plan.entries.filter((entry) => entry.kind === kind).length;
  note?.({
    kind: "planSummary",
    unchanged: count("unchanged"),
    changed: count("changed"),
    added: count("added"),
    removed: plan.removed.length,
  });
  for (const meta of plan.removed) {
    note?.({ kind: "metaRemoved", name: meta.name });
  }

  const vocabulary = extractVocabulary(input.trajectories);
  const sets = vocabularySets(vocabulary);

  const targets: UpdateTarget[] = plan.entries.flatMap((entry) => {
    if (entry.kind === "changed") return [{ section: entry.section, previous: entry.meta }];
    if (entry.kind === "added") return [{ section: entry.section }];
    return [];
  });
  let proposals = new Map<string, MetaBehaviorIr>();
  if (targets.length > 0) {
    note?.({ kind: "requestingUpdateProposal" });
    proposals = await completeJsonWithRetry(
      complete,
      buildUpdateProposalMessages({
        behaviorName: input.behaviorName,
        behaviorBody: input.behaviorBody,
        targets,
        vocabulary,
      }),
      (response) => parseUpdateProposal(response, input.behaviorName, targets),
    );
  }

  const changed = new Map<string, PreparedChangedSection>();
  for (const entry of plan.entries) {
    if (entry.kind !== "changed") continue;
    const proposed = proposals.get(entry.section.heading)!;
    const delta = computeSectionDelta(entry.meta, proposed, entry.section.body);

    const items: CarriedItem[] = [];
    if (delta.triggerCarried) {
      items.push({ id: "trigger", kind: "trigger", trigger: entry.meta.trigger });
    }
    delta.carriedChecks.forEach((check, index) => {
      items.push({ id: `check-${index + 1}`, kind: "check", check });
    });
    delta.carriedSemanticChecks.forEach((check, index) => {
      items.push({ id: `semantic-${index + 1}`, kind: "semantic", check });
    });

    const triage = new Map<string, TriageVerdict>();
    if (items.length > 0) {
      if (entry.meta.source === undefined) {
        // No recorded previous section text, so the edit's impact can't be
        // assessed: re-review every carried clause (the safe ceiling).
        for (const item of items) {
          triage.set(item.id, {
            reAsk: true,
            reason:
              "the IR did not record the previous section text, so the edit cannot be triaged",
          });
        }
      } else {
        const verdicts = await completeJsonWithRetry(
          complete,
          buildTriageMessages({
            metaName: entry.meta.name,
            previousSection: entry.meta.source,
            currentSection: entry.section.body,
            items: items.map((item) => ({
              id: item.id,
              description: carriedItemDescription(item),
            })),
          }),
          (response) =>
            parseTriageResult(
              response,
              items.map((item) => item.id),
            ),
        );
        for (const [id, verdict] of verdicts) triage.set(id, verdict);
      }
    }
    changed.set(entry.section.heading, { delta, items, triage });
  }

  return {
    behaviorName: input.behaviorName,
    trajectories: input.trajectories,
    sets,
    plan,
    proposals,
    changed,
  };
}

async function reviewChangedTrigger(
  previous: Trigger,
  proposed: Trigger,
  prepared: Pick<PreparedUpdate, "trajectories" | "sets">,
  presenter: UpdatePresenter,
  metaName: string,
  position: StepPosition,
): Promise<Trigger> {
  const step: ChangedTriggerStep = {
    kind: "changedTrigger",
    metaName,
    previous,
    proposed,
    unobserved: unobservedInTrigger(proposed, prepared.sets),
    position,
    ...("match" in proposed
      ? { evidence: patternEvidence(prepared.trajectories, "match", proposed.match) }
      : {}),
  };
  const answer = await presenter.askChangedTrigger(step);
  if (answer.kind === "keepPrevious") return previous;
  if (answer.kind === "forceSemantic") return { description: proposed.description, semantic: true };
  if (answer.kind === "edit") {
    const description = answer.description.trim();
    if (description.length === 0) return proposed;
    return "match" in proposed
      ? { ...proposed, description: capitalizeFirst(description) }
      : { description, semantic: true };
  }
  return proposed;
}

/**
 * Walk a prepared update through the presenter. Unchanged sections carry over
 * with zero questions; added sections review like plain generate; changed
 * sections ask only about the delta plus triage-flagged carried clauses.
 * Deterministic given (prepared, answers): no LLM calls, no IO.
 */
export async function runUpdateProposalInterview(
  prepared: PreparedUpdate,
  presenter: UpdatePresenter,
): Promise<JudgeIr | undefined> {
  const { plan, proposals, trajectories, sets } = prepared;

  const metaBehaviors: MetaBehaviorIr[] = [];
  const pushMeta = (
    name: string,
    trigger: Trigger,
    checks: PredicateCheck[],
    semanticChecks: SemanticCheck[],
    sourceBody: string,
  ) => {
    if (checks.length === 0 && semanticChecks.length === 0) {
      presenter.note({ kind: "metaDropped", name });
      return;
    }
    const meta: MetaBehaviorIr = { name, trigger, checks, semanticChecks };
    if (sourceBody.length > 0) meta.source = sourceBody;
    metaBehaviors.push(meta);
  };

  for (const [metaIndex, entry] of plan.entries.entries()) {
    const position: StepPosition = { metaIndex, metaCount: plan.entries.length };
    if (entry.kind === "unchanged") {
      presenter.note({ kind: "sectionHeader", name: entry.meta.name, status: "unchanged" });
      metaBehaviors.push(entry.meta);
      continue;
    }
    if (entry.kind === "added") {
      const proposed = proposals.get(entry.section.heading)!;
      presenter.note({ kind: "sectionHeader", name: entry.section.heading, status: "added" });
      const trigger = await reviewTrigger(
        proposed.trigger,
        trajectories,
        sets,
        presenter,
        entry.section.heading,
        position,
      );
      const { checks, demoted } = await reviewChecks(
        proposed.checks,
        trajectories,
        sets,
        presenter,
        entry.section.heading,
        position,
      );
      const semanticChecks = await reviewSemanticChecks(
        [
          ...proposed.semanticChecks.map((check) => ({ check, demoted: false })),
          ...demoted.map((check) => ({ check, demoted: true })),
        ],
        presenter,
        entry.section.heading,
        position,
      );
      pushMeta(entry.section.heading, trigger, checks, semanticChecks, entry.section.body);
      continue;
    }

    // Changed section: interview only what needs a human decision — the
    // trigger if it changed, triage-flagged carried clauses individually,
    // the unflagged rest as one batch confirm, and the new clauses.
    const proposed = proposals.get(entry.section.heading)!;
    presenter.note({ kind: "sectionHeader", name: entry.meta.name, status: "changed" });
    const { delta, items, triage } = prepared.changed.get(entry.section.heading)!;

    let trigger: Trigger = entry.meta.trigger;
    if (!delta.triggerCarried) {
      trigger = await reviewChangedTrigger(
        entry.meta.trigger,
        proposed.trigger,
        prepared,
        presenter,
        entry.meta.name,
        position,
      );
    }

    let batch = items.filter((item) => triage.get(item.id)?.reAsk !== true);
    let reAsk = items.filter((item) => triage.get(item.id)?.reAsk === true);
    if (batch.length > 0) {
      const answer = await presenter.askCarriedBatch({
        kind: "carriedBatch",
        metaName: entry.meta.name,
        items: batch.map((item) => carriedClause(item)),
        position,
      });
      if (answer.kind === "review") {
        reAsk = items;
        batch = [];
      }
    }

    const keptChecks: PredicateCheck[] = [];
    const keptSemantics: SemanticCheck[] = [];
    const demotedFromCarried: SemanticCheck[] = [];
    for (const item of batch) {
      if (item.kind === "check") keptChecks.push(item.check);
      if (item.kind === "semantic") keptSemantics.push(item.check);
    }
    for (const item of reAsk) {
      const verdict = triage.get(item.id);
      // Items here via a declined batch confirm carry an "unaffected" triage
      // verdict; only flagged items get the re-ask banner.
      const reAskReason = verdict?.reAsk === true ? verdict.reason : undefined;
      if (item.kind === "trigger") {
        trigger = await reviewTrigger(
          item.trigger,
          trajectories,
          sets,
          presenter,
          entry.meta.name,
          position,
          reAskReason,
        );
      } else if (item.kind === "check") {
        const { checks, demoted } = await reviewChecks(
          [item.check],
          trajectories,
          sets,
          presenter,
          entry.meta.name,
          position,
          reAskReason,
        );
        keptChecks.push(...checks);
        demotedFromCarried.push(...demoted);
      } else {
        keptSemantics.push(
          ...(await reviewSemanticChecks(
            [{ check: item.check, demoted: false }],
            presenter,
            entry.meta.name,
            position,
            reAskReason,
          )),
        );
      }
    }

    for (const check of delta.droppedChecks) {
      presenter.note({ kind: "clauseDropped", label: `${check.type} check`, quote: check.quote });
    }
    for (const check of delta.droppedSemanticChecks) {
      presenter.note({ kind: "clauseDropped", label: "semantic check", quote: check.quote });
    }

    let newKeptChecks: PredicateCheck[] = [];
    let demotedFromNew: SemanticCheck[] = [];
    if (delta.newChecks.length > 0) {
      const { checks, demoted } = await reviewChecks(
        delta.newChecks,
        trajectories,
        sets,
        presenter,
        entry.meta.name,
        position,
      );
      newKeptChecks = checks;
      demotedFromNew = demoted;
    }
    const newSemantics = [
      ...delta.newSemanticChecks.map((check) => ({ check, demoted: false })),
      ...demotedFromCarried.map((check) => ({ check, demoted: true })),
      ...demotedFromNew.map((check) => ({ check, demoted: true })),
    ];
    const keptNewSemantics =
      newSemantics.length > 0
        ? await reviewSemanticChecks(newSemantics, presenter, entry.meta.name, position)
        : [];

    pushMeta(
      entry.section.heading,
      trigger,
      [...keptChecks, ...newKeptChecks],
      [...keptSemantics, ...keptNewSemantics],
      entry.section.body,
    );
  }

  if (metaBehaviors.length === 0) {
    throw new Error("No meta-behaviors left after the interview; nothing to write.");
  }

  const statuses: Record<string, "unchanged" | "changed" | "added"> = {};
  for (const entry of plan.entries) statuses[entry.section.heading] = entry.kind;
  const ir: JudgeIr = { version: 1, behavior: prepared.behaviorName, metaBehaviors };
  const confirmed = await presenter.confirm({
    kind: "confirm",
    ir,
    yaml: serializeIr(ir),
    update: { statuses, removed: plan.removed.map((meta) => meta.name) },
  });
  return confirmed ? ir : undefined;
}

/**
 * The readline presentation of the update interview: the generate presenter
 * plus the two update-only steps, re-ask banners on triage-flagged clauses,
 * and update note rendering. Output is the CLI contract update.test.ts
 * scripts against.
 */
export function createTextUpdatePresenter(
  deps: Pick<InterviewDeps, "ask" | "write">,
): UpdatePresenter {
  const base = createTextPresenter(deps);
  const reAskBanner = (reAskReason: string | undefined) => {
    if (reAskReason !== undefined) {
      deps.write(`Re-asking — this clause needs re-review: ${reAskReason}`);
    }
  };
  return {
    ...base,

    note: (note) => {
      deps.write(renderUpdateNote(note));
    },

    askTrigger: (step) => {
      reAskBanner(step.reAskReason);
      return base.askTrigger(step);
    },

    askCheck: (step) => {
      reAskBanner(step.reAskReason);
      return base.askCheck(step);
    },

    askSemanticCheck: (step) => {
      reAskBanner(step.reAskReason);
      return base.askSemanticCheck(step);
    },

    askChangedTrigger: async (step) => {
      deps.write("Trigger changed.");
      deps.write(`  previous: ${triggerLine(step.previous)}`);
      deps.write(`  proposed: ${triggerLine(step.proposed)}`);
      if ("match" in step.proposed) {
        if (step.evidence !== undefined) writeEvidenceLines(deps, step.evidence);
        writeUnobservedWarning(deps, step.unobserved);
      } else {
        deps.write("  (semantic trigger: judged by one scoped LLM call)");
      }
      const answer = await askChoice(
        deps,
        "[y] accept proposed / [p] keep previous / [s] force semantic / [e] edit proposed description",
        ["y", "p", "s", "e"],
      );
      if (answer === "p") return { kind: "keepPrevious" };
      if (answer === "s") return { kind: "forceSemantic" };
      if (answer === "e") {
        return {
          kind: "edit",
          description: (
            await deps.ask("New trigger description: ", step.proposed.description)
          ).trim(),
        };
      }
      return { kind: "accept" };
    },

    askCarriedBatch: async (step) => {
      deps.write(
        `Carrying over ${step.items.length} clause(s) whose spec sentences are unchanged:`,
      );
      for (const item of step.items) {
        deps.write(`  ${carriedClauseLabel(item)}`);
      }
      const answer = await askChoice(deps, "Keep these? [y] yes / [n] review individually", [
        "y",
        "n",
      ]);
      return answer === "n" ? { kind: "review" } : { kind: "keep" };
    },

    confirm: async (step) => {
      deps.write("\nUpdated judge IR:\n");
      deps.write(step.yaml);
      const answer = await askChoice(deps, "Write this IR? [y] yes / [n] no", ["y", "n"]);
      return answer === "y";
    },
  };
}

/**
 * Run the diff-scoped update interview against an existing IR. Unchanged
 * sections carry over with zero questions and zero LLM calls; changed and
 * added sections get one shared scoped proposal call, and each changed
 * section with carried clauses gets one triage call. Returns the confirmed
 * IR, or undefined when the user declines to write it.
 */
export async function runUpdateInterview(
  input: UpdateInput,
  deps: InterviewDeps,
): Promise<JudgeIr | undefined> {
  const presenter = createTextUpdatePresenter(deps);
  const prepared = await prepareUpdate(input, deps.complete, (note) => {
    presenter.note(note);
  });
  return runUpdateProposalInterview(prepared, presenter);
}
