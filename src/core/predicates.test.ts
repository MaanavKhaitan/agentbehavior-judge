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

function agentEvent(id: string, action: string, content = action): TrajectoryEvent {
  return { id, actor: "agent", action, content };
}

describe("pairing predicate", () => {
  const check: PredicateCheck = {
    type: "pairing",
    quote: "reads the results of every search",
    each: { action: "web_search" },
    followedBy: { action: "web_search_result" },
  };
  const search = (id: string) => agentEvent(id, "web_search");
  const searchResult = (id: string): TrajectoryEvent => ({
    id,
    actor: "tool",
    action: "web_search_result",
    content: "results",
  });

  it("is true when every each-match has a later follower, citing the pairs", () => {
    const result = evaluatePredicate(
      check,
      trajectory([search("s1"), searchResult("r1"), search("s2"), searchResult("r2")]),
    );
    expect(result.verdict).toBe("true");
    expect(result.citedEvents.map((entry) => entry.id)).toEqual(["s1", "r1", "s2", "r2"]);
  });

  it("lets one follower satisfy multiple earlier matches", () => {
    const result = evaluatePredicate(
      check,
      trajectory([search("s1"), search("s2"), searchResult("r1")]),
    );
    expect(result.verdict).toBe("true");
    expect(result.citedEvents.map((entry) => entry.id)).toEqual(["s1", "r1", "s2"]);
  });

  it("is false citing the unmatched events when the trace is complete", () => {
    const result = evaluatePredicate(
      check,
      trajectory([search("s1"), searchResult("r1"), search("s2")]),
    );
    expect(result.verdict).toBe("false");
    expect(result.citedEvents.map((entry) => entry.id)).toEqual(["s2"]);
  });

  it("ignores followers that precede the match", () => {
    const result = evaluatePredicate(check, trajectory([searchResult("r1"), search("s1")]));
    expect(result.verdict).toBe("false");
  });

  it("is na insufficient_evidence for an unmatched event in an incomplete trace", () => {
    const result = evaluatePredicate(check, trajectory([search("s1")], false));
    expect(result).toMatchObject({ verdict: "na", naReason: "insufficient_evidence" });
  });

  it("is na when no each-match exists", () => {
    const events = [agentEvent("a1", "final_answer")];
    expect(evaluatePredicate(check, trajectory(events, true))).toMatchObject({
      verdict: "na",
      naReason: "not_applicable",
    });
    expect(evaluatePredicate(check, trajectory(events, false))).toMatchObject({
      verdict: "na",
      naReason: "insufficient_evidence",
    });
  });
});

describe("after-scoped predicates", () => {
  const answered = [agentEvent("e1", "web_search"), agentEvent("e2", "final_answer")];
  const answeredThenSearched = [agentEvent("e1", "final_answer"), agentEvent("e2", "web_search")];

  it("forbidden with after only sees events after the first after-match", () => {
    const check: PredicateCheck = {
      type: "forbidden",
      quote: "takes no further actions after answering",
      match: { actor: "agent" },
      after: { action: "final_answer" },
    };
    expect(evaluatePredicate(check, trajectory(answered)).verdict).toBe("true");
    const violated = evaluatePredicate(check, trajectory(answeredThenSearched));
    expect(violated.verdict).toBe("false");
    expect(violated.citedEvents.map((entry) => entry.id)).toEqual(["e2"]);
  });

  it("required with after ignores matches before the window", () => {
    const check: PredicateCheck = {
      type: "required",
      quote: "keeps researching after answering",
      match: { action: "web_search" },
      after: { action: "final_answer" },
    };
    expect(evaluatePredicate(check, trajectory(answeredThenSearched)).verdict).toBe("true");
    expect(evaluatePredicate(check, trajectory(answered)).verdict).toBe("false");
    expect(evaluatePredicate(check, trajectory(answered, false))).toMatchObject({
      verdict: "na",
      naReason: "insufficient_evidence",
    });
  });

  it("is na when the after window never opens", () => {
    const check: PredicateCheck = {
      type: "forbidden",
      quote: "takes no further actions after answering",
      match: { actor: "agent" },
      after: { action: "final_answer" },
    };
    const events = [agentEvent("e1", "web_search")];
    expect(evaluatePredicate(check, trajectory(events, true))).toMatchObject({
      verdict: "na",
      naReason: "not_applicable",
    });
    expect(evaluatePredicate(check, trajectory(events, false))).toMatchObject({
      verdict: "na",
      naReason: "insufficient_evidence",
    });
  });

  it("count with after counts only window matches", () => {
    const check: PredicateCheck = {
      type: "count",
      quote: "at most one follow-up search",
      match: { action: "web_search" },
      max: 1,
      after: { action: "final_answer" },
    };
    expect(evaluatePredicate(check, trajectory(answeredThenSearched)).verdict).toBe("true");
    expect(
      evaluatePredicate(
        check,
        trajectory([...answeredThenSearched, agentEvent("e3", "web_search")]),
      ).verdict,
    ).toBe("false");
  });
});

describe("count distinctBy", () => {
  function sourceResult(id: string, url: string): TrajectoryEvent {
    return {
      id,
      actor: "tool",
      action: "open_url_result",
      content: `content of ${url}`,
      metadata: { sourceType: "primary", url },
    };
  }
  const check: PredicateCheck = {
    type: "count",
    quote: "consults at least two distinct sources",
    match: { action: "open_url_result" },
    min: 2,
    distinctBy: "metadata.url",
  };

  it("counts distinct metadata values instead of raw matches", () => {
    const sameUrlTwice = [
      sourceResult("r1", "https://primary.example/a"),
      sourceResult("r2", "https://primary.example/a"),
    ];
    expect(evaluatePredicate(check, trajectory(sameUrlTwice)).verdict).toBe("false");

    const twoUrls = [
      sourceResult("r1", "https://primary.example/a"),
      sourceResult("r2", "https://primary.example/b"),
    ];
    const result = evaluatePredicate(check, trajectory(twoUrls));
    expect(result.verdict).toBe("true");
    expect(result.citedEvents.map((entry) => entry.id)).toEqual(["r1", "r2"]);
  });

  it("drops matches missing the metadata key", () => {
    const events = [
      sourceResult("r1", "https://primary.example/a"),
      { id: "r2", actor: "tool" as const, action: "open_url_result", content: "no metadata" },
    ];
    expect(evaluatePredicate(check, trajectory(events)).verdict).toBe("false");
  });

  it("counts distinct content values", () => {
    const contentCheck: PredicateCheck = { ...check, distinctBy: "content" };
    const events = [
      sourceResult("r1", "https://primary.example/a"),
      sourceResult("r2", "https://primary.example/a"),
      sourceResult("r3", "https://primary.example/b"),
    ];
    expect(evaluatePredicate(contentCheck, trajectory(events)).verdict).toBe("true");
  });
});
