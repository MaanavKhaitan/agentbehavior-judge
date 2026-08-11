import { describe, expect, it } from "vite-plus/test";

import type { PredicateCheck } from "./ir.js";
import { evaluatePredicate, findMatches, matchesEvent } from "./predicates.js";
import { taxCase } from "./taxFixtures.js";
import type { AgentTrajectory, TrajectoryEvent } from "./trajectory.js";

const event: TrajectoryEvent = {
  id: "event-1",
  actor: "tool",
  action: "open_url_result",
  content: "Example Tax Code section 10",
  metadata: { sourceType: "primary", url: "https://primary.example" },
};

function trajectory(events: TrajectoryEvent[], complete = true): AgentTrajectory {
  return { id: "test", description: "", complete, events };
}

describe("matchesEvent", () => {
  it("matches on action, actor, contentIncludes, and metadata", () => {
    expect(matchesEvent(event, { action: "open_url_result" })).toBe(true);
    expect(matchesEvent(event, { action: "open_url" })).toBe(false);
    expect(matchesEvent(event, { actor: "tool" })).toBe(true);
    expect(matchesEvent(event, { actor: "agent" })).toBe(false);
    expect(matchesEvent(event, { contentIncludes: "section 10" })).toBe(true);
    expect(matchesEvent(event, { contentIncludes: "section 99" })).toBe(false);
    expect(matchesEvent(event, { metadata: { sourceType: "primary" } })).toBe(true);
    expect(matchesEvent(event, { metadata: { sourceType: "secondary" } })).toBe(false);
    expect(matchesEvent(event, { metadata: { missing: "x" } })).toBe(false);
  });

  it("requires all set fields to match", () => {
    expect(matchesEvent(event, { action: "open_url_result", actor: "agent" })).toBe(false);
    expect(
      matchesEvent(event, { action: "open_url_result", metadata: { sourceType: "primary" } }),
    ).toBe(true);
  });

  it("treats a matcher array as any-of", () => {
    const events = taxCase("secondary-then-primary").trajectory.events;
    const matches = findMatches(events, [{ action: "web_search" }, { action: "open_url" }]);
    expect(matches.map((entry) => entry.id)).toEqual(["event-4", "event-6"]);
  });
});

describe("ordering predicate", () => {
  const check: PredicateCheck = {
    type: "ordering",
    quote: "reads the skill before searching",
    first: { action: "read_skill" },
    before: [{ action: "web_search" }, { action: "open_url" }],
  };

  it("is true when the first match precedes the before match", () => {
    const result = evaluatePredicate(check, taxCase("secondary-then-primary").trajectory);
    expect(result.verdict).toBe("true");
    expect(result.citedEvents.map((entry) => entry.id)).toEqual(["event-2", "event-4"]);
  });

  it("is false when a before match has no prior first match", () => {
    const result = evaluatePredicate(check, taxCase("skill-read-too-late").trajectory);
    expect(result.verdict).toBe("false");
    expect(result.citedEvents.map((entry) => entry.id)).toEqual(["event-2"]);
  });

  it("is false on a violation even when the trace is incomplete", () => {
    const events = taxCase("skill-read-too-late").trajectory.events;
    const result = evaluatePredicate(check, trajectory(events, false));
    expect(result.verdict).toBe("false");
  });

  it("is na not_applicable when no before match exists in a complete trace", () => {
    const result = evaluatePredicate(check, taxCase("correct-without-research").trajectory);
    expect(result).toMatchObject({ verdict: "na", naReason: "not_applicable" });
  });

  it("is na insufficient_evidence when no before match exists in an incomplete trace", () => {
    const events = taxCase("correct-without-research").trajectory.events;
    const result = evaluatePredicate(check, trajectory(events, false));
    expect(result).toMatchObject({ verdict: "na", naReason: "insufficient_evidence" });
  });
});

describe("required predicate", () => {
  const check: PredicateCheck = {
    type: "required",
    quote: "reads the relevant primary source",
    match: { action: "open_url_result", metadata: { sourceType: "primary" } },
  };

  it("is true when a match exists", () => {
    const result = evaluatePredicate(check, taxCase("primary-directly").trajectory);
    expect(result.verdict).toBe("true");
    expect(result.citedEvents.map((entry) => entry.id)).toEqual(["event-5"]);
  });

  it("is false when no match exists and the trace is complete", () => {
    const result = evaluatePredicate(check, taxCase("secondary-only").trajectory);
    expect(result).toMatchObject({ verdict: "false", naReason: null });
  });

  it("is na insufficient_evidence when no match exists and the trace is incomplete", () => {
    const events = taxCase("secondary-only").trajectory.events;
    const result = evaluatePredicate(check, trajectory(events, false));
    expect(result).toMatchObject({ verdict: "na", naReason: "insufficient_evidence" });
  });
});

describe("forbidden predicate", () => {
  const check: PredicateCheck = {
    type: "forbidden",
    quote: "does not rely on secondary sources alone",
    match: { action: "web_search" },
  };

  it("is false when a match exists, citing every match", () => {
    const result = evaluatePredicate(check, taxCase("secondary-only").trajectory);
    expect(result.verdict).toBe("false");
    expect(result.citedEvents.map((entry) => entry.id)).toEqual(["event-4"]);
  });

  it("is true when no match exists, even in an incomplete trace", () => {
    const events = taxCase("correct-without-research").trajectory.events;
    expect(evaluatePredicate(check, trajectory(events, true)).verdict).toBe("true");
    expect(evaluatePredicate(check, trajectory(events, false)).verdict).toBe("true");
  });
});

describe("count predicate", () => {
  const events = taxCase("secondary-then-primary").trajectory.events;

  it("is true within min/max bounds", () => {
    const check: PredicateCheck = {
      type: "count",
      quote: "opens at least one source",
      match: { action: "open_url" },
      min: 1,
      max: 3,
    };
    expect(evaluatePredicate(check, trajectory(events)).verdict).toBe("true");
  });

  it("is false over max", () => {
    const check: PredicateCheck = {
      type: "count",
      quote: "opens no source",
      match: { action: "open_url" },
      max: 0,
    };
    const result = evaluatePredicate(check, trajectory(events));
    expect(result.verdict).toBe("false");
    expect(result.citedEvents.length).toBeGreaterThan(0);
  });

  it("is false under min when the trace is complete", () => {
    const check: PredicateCheck = {
      type: "count",
      quote: "searches at least twice",
      match: { action: "web_search" },
      min: 2,
    };
    expect(evaluatePredicate(check, trajectory(events, true)).verdict).toBe("false");
  });

  it("is na insufficient_evidence under min when the trace is incomplete", () => {
    const check: PredicateCheck = {
      type: "count",
      quote: "searches at least twice",
      match: { action: "web_search" },
      min: 2,
    };
    expect(evaluatePredicate(check, trajectory(events, false))).toMatchObject({
      verdict: "na",
      naReason: "insufficient_evidence",
    });
  });

  it("is false over max even in an incomplete trace", () => {
    const check: PredicateCheck = {
      type: "count",
      quote: "opens no source",
      match: { action: "open_url" },
      max: 0,
    };
    expect(evaluatePredicate(check, trajectory(events, false)).verdict).toBe("false");
  });
});
