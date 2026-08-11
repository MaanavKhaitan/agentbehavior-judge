import type { EventMatcher, EventPattern, PredicateCheck } from "./ir.js";
import type { AgentTrajectory, BehaviorVerdict, NaReason, TrajectoryEvent } from "./trajectory.js";

export interface PredicateResult {
  verdict: BehaviorVerdict;
  naReason: NaReason | null;
  /** The events that decided the verdict (violating events for false, satisfying for true). */
  citedEvents: TrajectoryEvent[];
}

export function matchesEvent(event: TrajectoryEvent, matcher: EventMatcher): boolean {
  if (matcher.action !== undefined && event.action !== matcher.action) return false;
  if (matcher.actor !== undefined && event.actor !== matcher.actor) return false;
  if (matcher.contentIncludes !== undefined && !event.content.includes(matcher.contentIncludes)) {
    return false;
  }
  if (matcher.metadata !== undefined) {
    for (const [key, value] of Object.entries(matcher.metadata)) {
      if (event.metadata?.[key] !== value) return false;
    }
  }
  return true;
}

export function matchesAny(event: TrajectoryEvent, pattern: EventPattern): boolean {
  const matchers = Array.isArray(pattern) ? pattern : [pattern];
  return matchers.some((matcher) => matchesEvent(event, matcher));
}

export function findMatches(events: TrajectoryEvent[], pattern: EventPattern): TrajectoryEvent[] {
  return events.filter((event) => matchesAny(event, pattern));
}

function result(
  verdict: BehaviorVerdict,
  naReason: NaReason | null,
  citedEvents: TrajectoryEvent[],
): PredicateResult {
  return { verdict, naReason, citedEvents };
}

function evaluateOrdering(
  check: Extract<PredicateCheck, { type: "ordering" }>,
  trajectory: AgentTrajectory,
): PredicateResult {
  const events = trajectory.events;
  const firstIndex = events.findIndex((event) => matchesAny(event, check.first));
  const beforeIndex = events.findIndex((event) => matchesAny(event, check.before));

  if (beforeIndex === -1) {
    // Nothing to order against: the clause never came into play.
    return trajectory.complete
      ? result("na", "not_applicable", [])
      : result("na", "insufficient_evidence", []);
  }
  if (firstIndex !== -1 && firstIndex < beforeIndex) {
    return result("true", null, [events[firstIndex]!, events[beforeIndex]!]);
  }
  // A `before` event with no prior `first` event is an observed violation,
  // even in an incomplete trace.
  return result("false", null, [events[beforeIndex]!]);
}

function evaluateRequired(
  check: Extract<PredicateCheck, { type: "required" }>,
  trajectory: AgentTrajectory,
): PredicateResult {
  const matches = findMatches(trajectory.events, check.match);
  if (matches.length > 0) return result("true", null, [matches[0]!]);
  if (trajectory.complete) return result("false", null, []);
  return result("na", "insufficient_evidence", []);
}

function evaluateForbidden(
  check: Extract<PredicateCheck, { type: "forbidden" }>,
  trajectory: AgentTrajectory,
): PredicateResult {
  const matches = findMatches(trajectory.events, check.match);
  if (matches.length > 0) return result("false", null, matches);
  return result("true", null, []);
}

function evaluateCount(
  check: Extract<PredicateCheck, { type: "count" }>,
  trajectory: AgentTrajectory,
): PredicateResult {
  const matches = findMatches(trajectory.events, check.match);
  if (check.max !== undefined && matches.length > check.max) {
    return result("false", null, matches);
  }
  if (check.min !== undefined && matches.length < check.min) {
    return trajectory.complete
      ? result("false", null, matches)
      : result("na", "insufficient_evidence", []);
  }
  return result("true", null, matches);
}

export function evaluatePredicate(
  check: PredicateCheck,
  trajectory: AgentTrajectory,
): PredicateResult {
  switch (check.type) {
    case "ordering":
      return evaluateOrdering(check, trajectory);
    case "required":
      return evaluateRequired(check, trajectory);
    case "forbidden":
      return evaluateForbidden(check, trajectory);
    case "count":
      return evaluateCount(check, trajectory);
  }
}
