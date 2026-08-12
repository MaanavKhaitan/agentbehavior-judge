import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

import type { GatewayMessage, JudgeCompletion } from "./gateway.js";
import { parseIr, type JudgeIr } from "./ir.js";
import { compareToExpected, judgeTrajectory } from "./judge.js";
import { PRIMARY_SOURCES_META, READ_SKILL_META, taxCase } from "./taxFixtures.js";
import type { AgentTrajectory, TrajectoryEvent } from "./trajectory.js";

function queuedCompletion(responses: string[]): {
  complete: JudgeCompletion;
  calls: GatewayMessage[][];
} {
  const calls: GatewayMessage[][] = [];
  const queue = [...responses];
  return {
    calls,
    complete: (messages) => {
      calls.push(messages);
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(new Error("No queued judge response left."));
      }
      return Promise.resolve(next);
    },
  };
}

function semanticResponse(
  verdict: "true" | "false" | "na",
  eventId: string,
  naReason: "not_applicable" | "insufficient_evidence" | null = null,
): string {
  return JSON.stringify({
    verdict,
    na_reason: naReason,
    reasoning: "scripted test verdict",
    citations: [{ event_id: eventId, description: "scripted citation" }],
  });
}

const ir: JudgeIr = {
  version: 1,
  behavior: "test-behavior",
  metaBehaviors: [
    {
      name: "Meta A",
      trigger: { description: "The agent searches.", match: { action: "web_search" } },
      checks: [
        {
          type: "ordering",
          quote: "reads the skill before searching",
          first: { action: "read_skill" },
          before: { action: "web_search" },
        },
      ],
      semanticChecks: [
        { quote: "bases its conclusion on the source", question: "Did it base its conclusion?" },
      ],
    },
  ],
};

function trajectory(events: TrajectoryEvent[], complete = true): AgentTrajectory {
  return { id: "test-trajectory", description: "", complete, events };
}

function event(id: string, action: string): TrajectoryEvent {
  return { id, actor: "agent", action, content: action };
}

const passingEvents = [event("event-1", "read_skill"), event("event-2", "web_search")];
const violatingEvents = [event("event-1", "web_search"), event("event-2", "read_skill")];

describe("judgeTrajectory orchestration", () => {
  it("returns na with zero LLM calls when a predicate trigger has no match", async () => {
    const { complete, calls } = queuedCompletion([]);
    const judgment = await judgeTrajectory({
      ir,
      trajectory: trajectory([event("event-1", "final_answer")]),
      complete,
    });

    expect(calls).toHaveLength(0);
    expect(judgment.verdict).toBe("na");
    expect(judgment.metaBehaviors[0]).toMatchObject({
      verdict: "na",
      naReason: "not_applicable",
      triggered: false,
    });
  });

  it("marks an untriggered meta insufficient_evidence when the trace is incomplete", async () => {
    const { complete } = queuedCompletion([]);
    const judgment = await judgeTrajectory({
      ir,
      trajectory: trajectory([event("event-1", "final_answer")], false),
      complete,
    });

    expect(judgment.metaBehaviors[0]).toMatchObject({
      verdict: "na",
      naReason: "insufficient_evidence",
    });
  });

  it("runs one verify call for a predicate false and skips semantic checks when confirmed", async () => {
    const { complete, calls } = queuedCompletion([semanticResponse("false", "event-1")]);
    const judgment = await judgeTrajectory({
      ir,
      trajectory: trajectory(violatingEvents),
      complete,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]![1]!.content).toContain("A deterministic event-pattern check flagged");
    expect(judgment.verdict).toBe("false");
    const meta = judgment.metaBehaviors[0]!;
    expect(meta.verdict).toBe("false");
    expect(meta.clauses).toHaveLength(1);
    expect(meta.clauses[0]).toMatchObject({
      kind: "predicate",
      verdict: "false",
      verification: "confirmed",
    });
  });

  it("runs semantic checks and records both outcomes when the verifier overturns a false", async () => {
    const { complete, calls } = queuedCompletion([
      semanticResponse("true", "event-2"),
      semanticResponse("true", "event-2"),
    ]);
    const judgment = await judgeTrajectory({
      ir,
      trajectory: trajectory(violatingEvents),
      complete,
    });

    expect(calls).toHaveLength(2);
    const meta = judgment.metaBehaviors[0]!;
    expect(meta.verdict).toBe("true");
    expect(meta.clauses).toHaveLength(2);
    expect(meta.clauses[0]).toMatchObject({
      kind: "predicate",
      verdict: "true",
      verification: "overturned",
      predicateVerdict: "false",
    });
    expect(meta.clauses[1]).toMatchObject({ kind: "semantic", verdict: "true" });
  });

  it("keeps an unverified false with zero calls under --no-verify", async () => {
    const { complete, calls } = queuedCompletion([]);
    const judgment = await judgeTrajectory({
      ir,
      trajectory: trajectory(violatingEvents),
      complete,
      verify: false,
    });

    expect(calls).toHaveLength(0);
    expect(judgment.metaBehaviors[0]!.clauses[0]).toMatchObject({
      verdict: "false",
      verification: "unverified",
    });
  });

  it("keeps an unverified false and reports semantic checks as na when offline", async () => {
    const judgment = await judgeTrajectory({
      ir,
      trajectory: trajectory(violatingEvents),
      gateway: { apiKey: "" },
    });

    expect(judgment.metaBehaviors[0]!.clauses[0]).toMatchObject({
      verdict: "false",
      verification: "unverified",
    });

    const passing = await judgeTrajectory({
      ir,
      trajectory: trajectory(passingEvents),
      gateway: { apiKey: "" },
    });
    expect(passing.metaBehaviors[0]!.clauses[1]).toMatchObject({
      kind: "semantic",
      verdict: "na",
      naReason: "insufficient_evidence",
    });
  });

  it("retries once on an invalid semantic response and succeeds", async () => {
    const { complete, calls } = queuedCompletion([
      "not json at all",
      semanticResponse("true", "event-2"),
    ]);
    const judgment = await judgeTrajectory({ ir, trajectory: trajectory(passingEvents), complete });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.at(-1)!.content).toContain("failed validation");
    expect(judgment.metaBehaviors[0]!.clauses[1]).toMatchObject({
      kind: "semantic",
      verdict: "true",
    });
  });

  it("throws when the retry also fails validation", async () => {
    const { complete } = queuedCompletion([
      "not json at all",
      JSON.stringify({ verdict: "true", na_reason: null, reasoning: "x", citations: [] }),
    ]);
    await expect(
      judgeTrajectory({ ir, trajectory: trajectory(passingEvents), complete }),
    ).rejects.toThrow(/at least one citation/);
  });

  it("rejects citations of unknown events", async () => {
    const { complete } = queuedCompletion([
      semanticResponse("true", "event-99"),
      semanticResponse("true", "event-99"),
    ]);
    await expect(
      judgeTrajectory({ ir, trajectory: trajectory(passingEvents), complete }),
    ).rejects.toThrow(/unknown event event-99/);
  });

  it("routes a false from a new-style predicate (pairing) through the same single verify call", async () => {
    const pairingIr: JudgeIr = {
      version: 1,
      behavior: "test-behavior",
      metaBehaviors: [
        {
          name: "Meta A",
          trigger: { description: "The agent searches.", match: { action: "web_search" } },
          checks: [
            {
              type: "pairing",
              quote: "reads the results of every search",
              each: { action: "web_search" },
              followedBy: { action: "web_search_result" },
            },
          ],
          semanticChecks: [],
        },
      ],
    };
    const { complete, calls } = queuedCompletion([semanticResponse("false", "event-1")]);
    const judgment = await judgeTrajectory({
      ir: pairingIr,
      trajectory: trajectory([event("event-1", "web_search")]),
      complete,
    });

    expect(calls).toHaveLength(1);
    expect(judgment.verdict).toBe("false");
    expect(judgment.metaBehaviors[0]!.clauses[0]).toMatchObject({
      kind: "predicate",
      verdict: "false",
      verification: "confirmed",
    });
  });

  it("short-circuits an empty trajectory to na with zero calls", async () => {
    const { complete, calls } = queuedCompletion([]);
    const judgment = await judgeTrajectory({ ir, trajectory: trajectory([]), complete });

    expect(calls).toHaveLength(0);
    expect(judgment.verdict).toBe("na");
    expect(judgment.metaBehaviors[0]).toMatchObject({
      verdict: "na",
      naReason: "insufficient_evidence",
    });
  });
});

describe("checked-in tax reference IR", () => {
  async function loadTaxIr(): Promise<JudgeIr> {
    const source = await readFile(
      new URL("../../examples/primary-source-tax-research/judge.yaml", import.meta.url),
      "utf8",
    );
    return parseIr(source);
  }

  it("reproduces the expected verdicts for skill-read-too-late", async () => {
    const taxIr = await loadTaxIr();
    const { trajectory: taxTrajectory, expected } = taxCase("skill-read-too-late");
    // Call order: verify meta-1 ordering false, semantic trigger for meta 2,
    // then the meta-2 semantic check.
    const { complete, calls } = queuedCompletion([
      semanticResponse("false", "event-2"),
      semanticResponse("true", "event-6"),
      semanticResponse("true", "event-6"),
    ]);

    const judgment = await judgeTrajectory({ ir: taxIr, trajectory: taxTrajectory, complete });

    expect(calls).toHaveLength(3);
    expect(judgment.verdict).toBe(expected.verdict);
    expect(
      Object.fromEntries(judgment.metaBehaviors.map((meta) => [meta.name, meta.verdict])),
    ).toEqual(expected.metaBehaviorVerdicts);

    const comparison = compareToExpected(judgment, expected);
    expect(comparison.fileMatch).toBe(true);
    expect(comparison.metaComparisons.every((meta) => meta.match)).toBe(true);
  });

  it("judges the predicate-only meta correctly across all fixtures without an LLM", async () => {
    const taxIr = await loadTaxIr();
    const offlineIr: JudgeIr = { ...taxIr, metaBehaviors: [taxIr.metaBehaviors[0]!] };

    const verdicts: Record<string, string> = {};
    for (const id of [
      "secondary-then-primary",
      "primary-directly",
      "skill-read-too-late",
      "secondary-only",
      "correct-without-research",
      "tax-adjacent-writing",
    ]) {
      const judgment = await judgeTrajectory({
        ir: offlineIr,
        trajectory: taxCase(id).trajectory,
        gateway: { apiKey: "" },
        verify: false,
      });
      verdicts[id] = judgment.metaBehaviors[0]!.verdict;
    }

    expect(verdicts).toEqual({
      "secondary-then-primary": "true",
      "primary-directly": "true",
      "skill-read-too-late": "false",
      "secondary-only": "true",
      "correct-without-research": "na",
      "tax-adjacent-writing": "na",
    });

    for (const id of Object.keys(verdicts)) {
      expect(verdicts[id]).toBe(taxCase(id).expected.metaBehaviorVerdicts[READ_SKILL_META]);
    }
  });

  it("folds the semantic meta into the file verdict for secondary-only", async () => {
    const taxIr = await loadTaxIr();
    const { trajectory: taxTrajectory, expected } = taxCase("secondary-only");
    // Meta 1 passes deterministically; meta 2's semantic trigger fires, then
    // its ordering check (primary source before final answer) fails and the
    // verifier confirms.
    const { complete, calls } = queuedCompletion([
      semanticResponse("true", "event-8"),
      semanticResponse("false", "event-8"),
    ]);

    const judgment = await judgeTrajectory({ ir: taxIr, trajectory: taxTrajectory, complete });

    expect(calls).toHaveLength(2);
    expect(judgment.verdict).toBe(expected.verdict);
    const primaryMeta = judgment.metaBehaviors.find((meta) => meta.name === PRIMARY_SOURCES_META)!;
    expect(primaryMeta.verdict).toBe("false");
    expect(primaryMeta.clauses.some((clause) => clause.verification === "confirmed")).toBe(true);
  });
});
