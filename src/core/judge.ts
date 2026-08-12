import {
  completeWithBraintrustGateway,
  gatewayConfigFromEnv,
  type GatewayOptions,
  type JudgeCompletion,
} from "./gateway.js";
import {
  foldBehaviorVerdicts,
  type JudgeIr,
  type MetaBehaviorIr,
  type PredicateCheck,
  type Trigger,
} from "./ir.js";
import { evaluatePredicate, findMatches, type PredicateResult } from "./predicates.js";
import {
  buildSemanticCheckMessages,
  buildVerifyFalseMessages,
  runSemanticCall,
  type EventCitation,
  type SemanticResult,
} from "./semantic.js";
import type {
  AgentTrajectory,
  BehaviorVerdict,
  ExpectedBehaviorJudgment,
  NaReason,
  TrajectoryEvent,
} from "./trajectory.js";

export type Verification = "confirmed" | "overturned" | "unverified";

export interface ClauseResult {
  kind: "predicate" | "semantic";
  quote: string;
  verdict: BehaviorVerdict;
  naReason: NaReason | null;
  citations: EventCitation[];
  reasoning?: string;
  /** Present when a predicate `false` was reviewed by the verifier (or could not be). */
  verification?: Verification;
  /** The original predicate verdict, kept when the verifier overturned it. */
  predicateVerdict?: BehaviorVerdict;
}

export interface MetaBehaviorResult {
  name: string;
  verdict: BehaviorVerdict;
  naReason: NaReason | null;
  triggered: boolean;
  clauses: ClauseResult[];
}

export interface TrajectoryJudgment {
  behavior: string;
  trajectoryId: string;
  verdict: BehaviorVerdict;
  metaBehaviors: MetaBehaviorResult[];
}

export interface JudgeOptions {
  ir: JudgeIr;
  trajectory: AgentTrajectory;
  /** Injection seam for tests; defaults to the Braintrust Gateway when an API key is set. */
  complete?: JudgeCompletion;
  gateway?: GatewayOptions;
  /** Set false to skip verify-on-false LLM calls. Default true. */
  verify?: boolean;
}

function resolveCompletion(options: JudgeOptions): JudgeCompletion | undefined {
  if (options.complete !== undefined) return options.complete;
  const gateway = options.gateway ?? {};
  const apiKey = gateway.apiKey ?? gatewayConfigFromEnv().apiKey;
  if (apiKey.trim().length === 0) return undefined;
  return (messages) => completeWithBraintrustGateway(messages, gateway);
}

function predicateCitations(events: TrajectoryEvent[], description: string): EventCitation[] {
  return events.map((event) => ({
    eventId: event.id,
    description: `${event.actor} ${event.action}: ${description}`,
  }));
}

function notTriggeredMeta(
  name: string,
  naReason: NaReason,
  triggerClause?: ClauseResult,
): MetaBehaviorResult {
  return {
    name,
    verdict: "na",
    naReason,
    triggered: false,
    clauses: triggerClause === undefined ? [] : [triggerClause],
  };
}

type TriggerOutcome = { triggered: true } | { triggered: false; metaResult: MetaBehaviorResult };

async function evaluateTrigger(
  metaName: string,
  trigger: Trigger,
  trajectory: AgentTrajectory,
  behaviorName: string,
  complete: JudgeCompletion | undefined,
): Promise<TriggerOutcome> {
  if ("match" in trigger) {
    const matches = findMatches(trajectory.events, trigger.match);
    if (matches.length > 0) return { triggered: true };
    return {
      triggered: false,
      metaResult: notTriggeredMeta(
        metaName,
        trajectory.complete ? "not_applicable" : "insufficient_evidence",
      ),
    };
  }

  if (complete === undefined) {
    return {
      triggered: false,
      metaResult: notTriggeredMeta(metaName, "insufficient_evidence", {
        kind: "semantic",
        quote: trigger.description,
        verdict: "na",
        naReason: "insufficient_evidence",
        citations: [],
        reasoning: "Semantic trigger skipped: no LLM completion available.",
      }),
    };
  }

  const result = await runSemanticCall(
    complete,
    buildSemanticCheckMessages({
      behaviorName,
      metaBehaviorName: metaName,
      quote: trigger.description,
      question: `Did this condition occur in the trajectory: ${trigger.description} Answer "true" if it occurred, "false" if it did not.`,
      trajectory,
    }),
    trajectory,
  );

  if (result.verdict === "true") return { triggered: true };

  const triggerClause: ClauseResult = {
    kind: "semantic",
    quote: trigger.description,
    verdict: "na",
    naReason: result.verdict === "false" ? "not_applicable" : result.naReason,
    citations: result.citations,
    reasoning: result.reasoning,
  };
  return {
    triggered: false,
    metaResult: notTriggeredMeta(
      metaName,
      triggerClause.naReason ?? "not_applicable",
      triggerClause,
    ),
  };
}

async function evaluatePredicateClause(
  metaName: string,
  check: PredicateCheck,
  result: PredicateResult,
  trajectory: AgentTrajectory,
  behaviorName: string,
  complete: JudgeCompletion | undefined,
  verify: boolean,
): Promise<ClauseResult> {
  const clause: ClauseResult = {
    kind: "predicate",
    quote: check.quote,
    verdict: result.verdict,
    naReason: result.naReason,
    citations: predicateCitations(result.citedEvents, `decided this ${check.type} check`),
  };

  if (result.verdict !== "false") return clause;

  if (!verify || complete === undefined) {
    clause.verification = "unverified";
    return clause;
  }

  const verifierResult = await runSemanticCall(
    complete,
    buildVerifyFalseMessages({
      behaviorName,
      metaBehaviorName: metaName,
      quote: check.quote,
      flaggedEvents: result.citedEvents,
      trajectory,
    }),
    trajectory,
  );

  if (verifierResult.verdict === "false") {
    clause.verification = "confirmed";
    clause.reasoning = verifierResult.reasoning;
    return clause;
  }

  return {
    kind: "predicate",
    quote: check.quote,
    verdict: verifierResult.verdict,
    naReason: verifierResult.naReason,
    citations: verifierResult.citations,
    reasoning: verifierResult.reasoning,
    verification: "overturned",
    predicateVerdict: "false",
  };
}

async function judgeMetaBehavior(
  meta: MetaBehaviorIr,
  trajectory: AgentTrajectory,
  behaviorName: string,
  complete: JudgeCompletion | undefined,
  verify: boolean,
): Promise<MetaBehaviorResult> {
  const triggerOutcome = await evaluateTrigger(
    meta.name,
    meta.trigger,
    trajectory,
    behaviorName,
    complete,
  );
  if (!triggerOutcome.triggered) return triggerOutcome.metaResult;

  const clauses: ClauseResult[] = [];
  for (const check of meta.checks) {
    const predicateResult = evaluatePredicate(check, trajectory);
    clauses.push(
      await evaluatePredicateClause(
        meta.name,
        check,
        predicateResult,
        trajectory,
        behaviorName,
        complete,
        verify,
      ),
    );
  }

  const hasFalse = clauses.some((clause) => clause.verdict === "false");
  if (!hasFalse) {
    for (const semanticCheck of meta.semanticChecks) {
      if (complete === undefined) {
        clauses.push({
          kind: "semantic",
          quote: semanticCheck.quote,
          verdict: "na",
          naReason: "insufficient_evidence",
          citations: [],
          reasoning: "Semantic check skipped: no LLM completion available.",
        });
        continue;
      }
      const result: SemanticResult = await runSemanticCall(
        complete,
        buildSemanticCheckMessages({
          behaviorName,
          metaBehaviorName: meta.name,
          quote: semanticCheck.quote,
          question: semanticCheck.question,
          trajectory,
        }),
        trajectory,
      );
      clauses.push({
        kind: "semantic",
        quote: semanticCheck.quote,
        verdict: result.verdict,
        naReason: result.naReason,
        citations: result.citations,
        reasoning: result.reasoning,
      });
    }
  }

  const verdict = foldBehaviorVerdicts(clauses.map((clause) => clause.verdict));
  let naReason: NaReason | null = null;
  if (verdict === "na") {
    naReason =
      clauses.find((clause) => clause.verdict === "na")?.naReason ?? "insufficient_evidence";
  }

  return { name: meta.name, verdict, naReason, triggered: true, clauses };
}

export async function judgeTrajectory(options: JudgeOptions): Promise<TrajectoryJudgment> {
  const { ir, trajectory } = options;
  const verify = options.verify ?? true;

  if (trajectory.events.length === 0) {
    return {
      behavior: ir.behavior,
      trajectoryId: trajectory.id,
      verdict: "na",
      metaBehaviors: ir.metaBehaviors.map((meta) =>
        notTriggeredMeta(meta.name, "insufficient_evidence"),
      ),
    };
  }

  const complete = resolveCompletion(options);
  const metaBehaviors: MetaBehaviorResult[] = [];
  for (const meta of ir.metaBehaviors) {
    metaBehaviors.push(await judgeMetaBehavior(meta, trajectory, ir.behavior, complete, verify));
  }

  return {
    behavior: ir.behavior,
    trajectoryId: trajectory.id,
    verdict: foldBehaviorVerdicts(metaBehaviors.map((meta) => meta.verdict)),
    metaBehaviors,
  };
}

export interface MetaComparison {
  name: string;
  expected: BehaviorVerdict | undefined;
  actual: BehaviorVerdict;
  match: boolean;
}

export interface JudgmentComparison {
  trajectoryId: string;
  fileExpected: BehaviorVerdict;
  fileActual: BehaviorVerdict;
  fileMatch: boolean;
  metaComparisons: MetaComparison[];
}

export function compareToExpected(
  judgment: TrajectoryJudgment,
  expected: ExpectedBehaviorJudgment,
): JudgmentComparison {
  const metaComparisons = judgment.metaBehaviors.map((meta): MetaComparison => {
    const expectedVerdict = expected.metaBehaviorVerdicts[meta.name];
    return {
      name: meta.name,
      expected: expectedVerdict,
      actual: meta.verdict,
      match: expectedVerdict === undefined ? false : expectedVerdict === meta.verdict,
    };
  });
  return {
    trajectoryId: judgment.trajectoryId,
    fileExpected: expected.verdict,
    fileActual: judgment.verdict,
    fileMatch: expected.verdict === judgment.verdict,
    metaComparisons,
  };
}
