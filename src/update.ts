import { stringify as stringifyYaml } from "yaml";

import {
  askChoice,
  capitalizeFirst,
  extractVocabulary,
  interviewChecks,
  interviewSemanticChecks,
  interviewTrigger,
  parseProposal,
  PROPOSAL_SYSTEM_PROMPT,
  renderPattern,
  splitSpecSections,
  unobservedInTrigger,
  vocabularySets,
  writeEvidence,
  writeUnobservedWarning,
  type ActionVocabulary,
  type InterviewDeps,
  type SpecSection,
  type VocabularySets,
} from "./generate.js";
import {
  completeJsonWithRetry,
  isRecord,
  parseJsonObject,
  requireNonEmptyString,
  type GatewayMessage,
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
Include every listed id exactly once. Use "re_ask" whenever you are unsure.`;

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
// Update interview.
// ---------------------------------------------------------------------------

export interface UpdateInput {
  behaviorName: string;
  behaviorBody: string;
  existing: JudgeIr;
  trajectories: AgentTrajectory[];
}

type CarriedItem =
  | { id: "trigger"; kind: "trigger"; trigger: Trigger }
  | { id: string; kind: "check"; check: PredicateCheck }
  | { id: string; kind: "semantic"; check: SemanticCheck };

function triggerLine(trigger: Trigger): string {
  return "match" in trigger
    ? `${trigger.description} match: ${renderPattern(trigger.match)}`
    : `${trigger.description} (semantic)`;
}

function carriedLabel(item: CarriedItem): string {
  if (item.kind === "trigger") return `trigger: ${triggerLine(item.trigger)}`;
  if (item.kind === "check") return `${item.check.type}: "${item.check.quote}"`;
  return `semantic: "${item.check.quote}"`;
}

function carriedItemDescription(item: CarriedItem): string {
  if (item.kind === "trigger") return `trigger ${JSON.stringify(item.trigger)}`;
  if (item.kind === "check") return `predicate check ${JSON.stringify(item.check)}`;
  return `semantic check ${JSON.stringify(item.check)}`;
}

async function interviewChangedTrigger(
  previous: Trigger,
  proposed: Trigger,
  trajectories: AgentTrajectory[],
  sets: VocabularySets,
  deps: InterviewDeps,
): Promise<Trigger> {
  deps.write("Trigger changed.");
  deps.write(`  previous: ${triggerLine(previous)}`);
  deps.write(`  proposed: ${triggerLine(proposed)}`);
  if ("match" in proposed) {
    writeEvidence(deps, trajectories, proposed.match);
    writeUnobservedWarning(deps, unobservedInTrigger(proposed, sets));
  } else {
    deps.write("  (semantic trigger: judged by one scoped LLM call)");
  }
  const answer = await askChoice(
    deps,
    "[y] accept proposed / [p] keep previous / [s] force semantic / [e] edit proposed description",
    ["y", "p", "s", "e"],
  );
  if (answer === "p") return previous;
  if (answer === "s") return { description: proposed.description, semantic: true };
  if (answer === "e") {
    const description = (await deps.ask("New trigger description: ", proposed.description)).trim();
    if (description.length === 0) return proposed;
    return "match" in proposed
      ? { ...proposed, description: capitalizeFirst(description) }
      : { description, semantic: true };
  }
  return proposed;
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
  deps.write(
    `Spec sections: ${count("unchanged")} unchanged, ${count("changed")} changed, ${count("added")} added; ${plan.removed.length} meta-behavior(s) removed.`,
  );
  for (const meta of plan.removed) {
    deps.write(`note: "${meta.name}" removed — its section no longer appears in the spec.`);
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
    deps.write(
      "Requesting revised meta-behaviors from the model; this can take a minute or two...",
    );
    proposals = await completeJsonWithRetry(
      deps.complete,
      buildUpdateProposalMessages({
        behaviorName: input.behaviorName,
        behaviorBody: input.behaviorBody,
        targets,
        vocabulary,
      }),
      (response) => parseUpdateProposal(response, input.behaviorName, targets),
    );
  }

  const metaBehaviors: MetaBehaviorIr[] = [];
  const pushMeta = (
    name: string,
    trigger: Trigger,
    checks: PredicateCheck[],
    semanticChecks: SemanticCheck[],
    sourceBody: string,
  ) => {
    if (checks.length === 0 && semanticChecks.length === 0) {
      deps.write(`note: "${name}" has no checks left; dropping it.`);
      return;
    }
    const meta: MetaBehaviorIr = { name, trigger, checks, semanticChecks };
    if (sourceBody.length > 0) meta.source = sourceBody;
    metaBehaviors.push(meta);
  };

  for (const entry of plan.entries) {
    if (entry.kind === "unchanged") {
      deps.write(`\n## ${entry.meta.name} — unchanged; carried over.`);
      metaBehaviors.push(entry.meta);
      continue;
    }
    if (entry.kind === "added") {
      const proposed = proposals.get(entry.section.heading)!;
      deps.write(`\n## ${entry.section.heading} — new section.`);
      const trigger = await interviewTrigger(proposed.trigger, input.trajectories, sets, deps);
      const { checks, demoted } = await interviewChecks(
        proposed.checks,
        input.trajectories,
        sets,
        deps,
      );
      const semanticChecks = await interviewSemanticChecks(
        [...proposed.semanticChecks, ...demoted],
        deps,
      );
      pushMeta(entry.section.heading, trigger, checks, semanticChecks, entry.section.body);
      continue;
    }

    // Changed section: mechanical delta, then demote-only triage over the
    // carried clauses, then interview only what needs a human decision.
    const proposed = proposals.get(entry.section.heading)!;
    deps.write(`\n## ${entry.meta.name} — section changed.`);
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
          deps.complete,
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

    let trigger: Trigger = entry.meta.trigger;
    if (!delta.triggerCarried) {
      trigger = await interviewChangedTrigger(
        entry.meta.trigger,
        proposed.trigger,
        input.trajectories,
        sets,
        deps,
      );
    }

    let batch = items.filter((item) => triage.get(item.id)?.reAsk !== true);
    let reAsk = items.filter((item) => triage.get(item.id)?.reAsk === true);
    if (batch.length > 0) {
      deps.write(`Carrying over ${batch.length} clause(s) whose spec sentences are unchanged:`);
      for (const item of batch) {
        deps.write(`  ${carriedLabel(item)}`);
      }
      const answer = await askChoice(deps, "Keep these? [y] yes / [n] review individually", [
        "y",
        "n",
      ]);
      if (answer === "n") {
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
      if (verdict?.reAsk === true) {
        deps.write(`Re-asking — the edit may affect this clause: ${verdict.reason}`);
      }
      if (item.kind === "trigger") {
        trigger = await interviewTrigger(item.trigger, input.trajectories, sets, deps);
      } else if (item.kind === "check") {
        const { checks, demoted } = await interviewChecks(
          [item.check],
          input.trajectories,
          sets,
          deps,
        );
        keptChecks.push(...checks);
        demotedFromCarried.push(...demoted);
      } else {
        keptSemantics.push(...(await interviewSemanticChecks([item.check], deps)));
      }
    }

    for (const check of delta.droppedChecks) {
      deps.write(
        `note: dropped ${check.type} check "${check.quote}" — its quoted sentence no longer appears in the section.`,
      );
    }
    for (const check of delta.droppedSemanticChecks) {
      deps.write(
        `note: dropped semantic check "${check.quote}" — its quoted sentence no longer appears in the section.`,
      );
    }

    let newKeptChecks: PredicateCheck[] = [];
    let demotedFromNew: SemanticCheck[] = [];
    if (delta.newChecks.length > 0) {
      const { checks, demoted } = await interviewChecks(
        delta.newChecks,
        input.trajectories,
        sets,
        deps,
      );
      newKeptChecks = checks;
      demotedFromNew = demoted;
    }
    const newSemantics = [...delta.newSemanticChecks, ...demotedFromCarried, ...demotedFromNew];
    const keptNewSemantics =
      newSemantics.length > 0 ? await interviewSemanticChecks(newSemantics, deps) : [];

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

  const ir: JudgeIr = { version: 1, behavior: input.behaviorName, metaBehaviors };
  const rendered = serializeIr(ir);
  deps.write("\nUpdated judge IR:\n");
  deps.write(rendered);
  const confirm = await askChoice(deps, "Write this IR? [y] yes / [n] no", ["y", "n"]);
  return confirm === "y" ? ir : undefined;
}
