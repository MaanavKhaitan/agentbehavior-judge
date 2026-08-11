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

function evaluatePairing(
  check: Extract<PredicateCheck, { type: "pairing" }>,
  trajectory: AgentTrajectory,
): PredicateResult {
  const events = trajectory.events;
  const satisfied: TrajectoryEvent[] = [];
  const unmatched: TrajectoryEvent[] = [];
  for (const [index, event] of events.entries()) {
    if (!matchesAny(event, check.each)) continue;
    const follower = events.slice(index + 1).find((later) => matchesAny(later, check.followedBy));
    if (follower === undefined) unmatched.push(event);
    else satisfied.push(event, follower);
  }
  if (satisfied.length === 0 && unmatched.length === 0) {
    // No `each` event: the clause never came into play.
    return trajectory.complete
      ? result("na", "not_applicable", [])
      : result("na", "insufficient_evidence", []);
  }
  if (unmatched.length === 0) {
    return result("true", null, [...new Map(satisfied.map((event) => [event.id, event])).values()]);
  }
  // A missing follower may still arrive in an incomplete trace.
  return trajectory.complete
    ? result("false", null, unmatched)
    : result("na", "insufficient_evidence", []);
}

/**
 * Events strictly after the first `after`-match, or undefined when the window
 * never opens.
 */
function windowAfter(
  events: TrajectoryEvent[],
  after: EventPattern,
): TrajectoryEvent[] | undefined {
  const index = events.findIndex((event) => matchesAny(event, after));
  return index === -1 ? undefined : events.slice(index + 1);
}

function windowNeverOpened(trajectory: AgentTrajectory): PredicateResult {
  return trajectory.complete
    ? result("na", "not_applicable", [])
    : result("na", "insufficient_evidence", []);
}

function evaluateRequired(
  check: Extract<PredicateCheck, { type: "required" }>,
  trajectory: AgentTrajectory,
): PredicateResult {
  const events =
    check.after === undefined ? trajectory.events : windowAfter(trajectory.events, check.after);
  if (events === undefined) return windowNeverOpened(trajectory);
  const matches = findMatches(events, check.match);
  if (matches.length > 0) return result("true", null, [matches[0]!]);
  if (trajectory.complete) return result("false", null, []);
  return result("na", "insufficient_evidence", []);
}

function evaluateForbidden(
  check: Extract<PredicateCheck, { type: "forbidden" }>,
  trajectory: AgentTrajectory,
): PredicateResult {
  const events =
    check.after === undefined ? trajectory.events : windowAfter(trajectory.events, check.after);
  if (events === undefined) return windowNeverOpened(trajectory);
  const matches = findMatches(events, check.match);
  if (matches.length > 0) return result("false", null, matches);
  return result("true", null, []);
}

/** One representative match per distinct value; matches missing the value are dropped. */
function distinctMatches(matches: TrajectoryEvent[], distinctBy: string): TrajectoryEvent[] {
  const seen = new Set<string>();
  const kept: TrajectoryEvent[] = [];
  for (const match of matches) {
    const value =
      distinctBy === "content"
        ? match.content
        : match.metadata?.[distinctBy.slice("metadata.".length)];
    if (value === undefined || seen.has(value)) continue;
    seen.add(value);
    kept.push(match);
  }
  return kept;
}

function evaluateCount(
  check: Extract<PredicateCheck, { type: "count" }>,
  trajectory: AgentTrajectory,
): PredicateResult {
  const events =
    check.after === undefined ? trajectory.events : windowAfter(trajectory.events, check.after);
  if (events === undefined) return windowNeverOpened(trajectory);
  let matches = findMatches(events, check.match);
  if (check.distinctBy !== undefined) matches = distinctMatches(matches, check.distinctBy);
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
    case "pairing":
      return evaluatePairing(check, trajectory);
    case "required":
      return evaluateRequired(check, trajectory);
    case "forbidden":
      return evaluateForbidden(check, trajectory);
    case "count":
      return evaluateCount(check, trajectory);
  }
}
