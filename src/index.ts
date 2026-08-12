export {
  behaviorVerdictToScore,
  foldBehaviorVerdicts,
  parseIr,
  serializeIr,
  type EventMatcher,
  type EventPattern,
  type JudgeIr,
  type MetaBehaviorIr,
  type PredicateCheck,
  type SemanticCheck,
  type Trigger,
} from "./core/ir.js";
export { loadBehaviorSpec, type BehaviorSpec } from "./core/spec.js";
export {
  loadTrajectoryFile,
  type AgentTrajectory,
  type BehaviorVerdict,
  type ExpectedBehaviorJudgment,
  type NaReason,
  type TrajectoryCase,
  type TrajectoryEvent,
} from "./core/trajectory.js";
export {
  evaluatePredicate,
  findMatches,
  matchesAny,
  matchesEvent,
  type PredicateResult,
} from "./core/predicates.js";
export {
  completeJsonWithRetry,
  completeWithBraintrustGateway,
  gatewayConfigFromEnv,
  type GatewayMessage,
  type GatewayOptions,
  type JudgeCompletion,
} from "./core/gateway.js";
export {
  buildSemanticCheckMessages,
  buildVerifyFalseMessages,
  parseSemanticResult,
  type EventCitation,
  type SemanticResult,
} from "./core/semantic.js";
export {
  compareToExpected,
  judgeTrajectory,
  type ClauseResult,
  type JudgeOptions,
  type JudgmentComparison,
  type MetaBehaviorResult,
  type MetaComparison,
  type TrajectoryJudgment,
  type Verification,
} from "./core/judge.js";
export {
  extractMetaBehaviorNames,
  extractVocabulary,
  normalizeSectionBody,
  runInterview,
  splitSpecSections,
  unobservedInCheck,
  unobservedInTrigger,
  vocabularySets,
  type ActionVocabulary,
  type InterviewDeps,
  type InterviewInput,
  type SpecSection,
  type VocabularySets,
} from "./interview/generate.js";
export {
  computeSectionDelta,
  planUpdate,
  runUpdateInterview,
  type SectionDelta,
  type UpdateEntry,
  type UpdateInput,
  type UpdatePlan,
} from "./interview/update.js";
