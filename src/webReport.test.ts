import { describe, expect, it } from "vite-plus/test";

import { parseIr } from "./ir.js";
import { judgeTrajectory } from "./judge.js";
import { taxCase } from "./taxFixtures.js";
import type { TrajectoryCase } from "./trajectory.js";
import { runWebReport, type WebReportOptions } from "./webReport.js";
import { ReportClient, watchReport, type ReportSnapshot } from "./webReportTestClient.js";

const predicateIr = parseIr(`version: 1
behavior: primary-source-tax-research
metaBehaviors:
  - name: Read the tax research skill before beginning source research
    trigger:
      description: The agent begins source research.
      match:
        - action: web_search
        - action: open_url
    checks:
      - type: ordering
        quote: the agent first reads the tax research skill, before searching or opening a source
        first:
          action: read_skill
        before:
          - action: web_search
          - action: open_url
`);

const defaultCases: TrajectoryCase[] = [
  taxCase("secondary-then-primary"),
  taxCase("skill-read-too-late"),
  taxCase("tax-adjacent-writing"),
];

/** Predicate-only judging: the throwing seam proves zero LLM calls happen. */
function offlineJudge(trajectoryCase: TrajectoryCase) {
  return judgeTrajectory({
    ir: predicateIr,
    trajectory: trajectoryCase.trajectory,
    verify: false,
    complete: () => Promise.reject(new Error("no LLM calls expected in this test")),
  });
}

function startReport(overrides?: {
  ir?: WebReportOptions["ir"];
  cases?: TrajectoryCase[];
  judgeCase?: WebReportOptions["judgeCase"];
}) {
  const logs: string[] = [];
  let resolveUrl!: (url: string) => void;
  const url = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const result = runWebReport({
    ir: overrides?.ir ?? predicateIr,
    cases: overrides?.cases ?? defaultCases,
    judgeCase: overrides?.judgeCase ?? offlineJudge,
    log: (line) => {
      logs.push(line);
    },
    openBrowser: (reportUrl) => {
      resolveUrl(reportUrl);
    },
  });
  return { url, result, logs };
}

async function nextOfType(
  client: ReportClient,
  type: ReportSnapshot["state"]["type"],
): Promise<ReportSnapshot> {
  for (;;) {
    const snapshot = await client.next();
    if (snapshot.state.type === type) return snapshot;
  }
}

function metasOf(judgment: Record<string, unknown>): Array<Record<string, unknown>> {
  return judgment.metaBehaviors as Array<Record<string, unknown>>;
}

function clausesOf(meta: Record<string, unknown>): Array<Record<string, unknown>> {
  return meta.clauses as Array<Record<string, unknown>>;
}

describe("runWebReport", () => {
  it("streams judging progress and resolves once the page acks the report", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { url, result, logs } = startReport({
      judgeCase: async (trajectoryCase) => {
        await gate;
        return offlineJudge(trajectoryCase);
      },
    });
    const client = await ReportClient.connect(await url);

    try {
      const first = await client.next();
      expect(first.behavior).toBe("primary-source-tax-research");
      expect(first.state).toMatchObject({
        type: "judging",
        done: 0,
        total: 3,
        judgingId: "secondary-then-primary",
      });
      expect(first.state.judgments).toEqual([]);
      releaseFirst();

      const second = await client.next();
      expect(second.state).toMatchObject({
        type: "judging",
        done: 1,
        judgingId: "skill-read-too-late",
      });
      expect(second.state.judgments).toHaveLength(1);

      const report = await nextOfType(client, "report");
      const judgments = report.state.judgments!;
      expect(judgments).toHaveLength(3);

      // Pass: enriched citations point at the deciding events, and predicate
      // citation boilerplate is dropped in favor of the events themselves.
      expect(judgments[0]).toMatchObject({
        trajectoryId: "secondary-then-primary",
        verdict: "true",
        complete: true,
      });
      const passMeta = metasOf(judgments[0]!)[0]!;
      expect(passMeta).toMatchObject({
        triggered: true,
        verdict: "true",
        semanticTrigger: false,
        triggerDescription: "The agent begins source research.",
      });
      const passClause = clausesOf(passMeta)[0]!;
      expect(passClause).toMatchObject({
        role: "check",
        kind: "predicate",
        checkType: "ordering",
        verdict: "true",
        verification: null,
      });
      const citations = passClause.citations as Array<{
        eventId: string;
        description: string | null;
        event: { actor: string; action: string } | null;
      }>;
      expect(citations.map((citation) => citation.eventId)).toEqual(["event-2", "event-4"]);
      expect(citations[0]!.event).toMatchObject({ actor: "agent", action: "read_skill" });
      expect(citations[0]!.description).toBeNull();

      // Fail: verify was off, so the false stays unverified.
      const failClause = clausesOf(metasOf(judgments[1]!)[0]!)[0]!;
      expect(failClause).toMatchObject({ verdict: "false", verification: "unverified" });

      // Not triggered: no clauses, and the trigger description explains why.
      const naMeta = metasOf(judgments[2]!)[0]!;
      expect(naMeta).toMatchObject({
        triggered: false,
        verdict: "na",
        naReason: "not_applicable",
        clauses: [],
      });

      expect(await client.ack()).toBe(200);
      const resolved = await result;
      expect(resolved.map((judgment) => [judgment.trajectoryId, judgment.verdict])).toEqual([
        ["secondary-then-primary", "true"],
        ["skill-read-too-late", "false"],
        ["tax-adjacent-writing", "na"],
      ]);
      expect(logs.some((line) => line.startsWith("Report running at http://127.0.0.1:"))).toBe(
        true,
      );
    } finally {
      client.close();
    }
  });

  it("keeps model-written citation descriptions and reasoning on semantic clauses", async () => {
    const semanticIr = parseIr(`version: 1
behavior: primary-source-tax-research
metaBehaviors:
  - name: Consult primary sources before answering
    trigger:
      description: The agent answers a tax question.
      semantic: true
    semanticChecks:
      - quote: bases its conclusion on that source
        question: Does the final answer base its conclusion on the primary source?
`);
    const responses = [
      // Case 1: semantic trigger fires, semantic check passes.
      JSON.stringify({
        verdict: "true",
        na_reason: null,
        reasoning: "The agent answers a tax question.",
        citations: [{ event_id: "event-1", description: "the user asks about deductions" }],
      }),
      JSON.stringify({
        verdict: "true",
        na_reason: null,
        reasoning: "The answer cites the primary source.",
        citations: [{ event_id: "event-7", description: "the primary source read" }],
      }),
      // Case 2: semantic trigger says the rule never applied.
      JSON.stringify({
        verdict: "false",
        na_reason: null,
        reasoning: "The run is an email rewrite, not a tax question.",
        citations: [{ event_id: "event-1", description: "the user asks for a rewrite" }],
      }),
    ];
    const { url, result } = startReport({
      ir: semanticIr,
      cases: [taxCase("secondary-then-primary"), taxCase("tax-adjacent-writing")],
      judgeCase: (trajectoryCase) =>
        judgeTrajectory({
          ir: semanticIr,
          trajectory: trajectoryCase.trajectory,
          complete: () => Promise.resolve(responses.shift()!),
        }),
    });

    const snapshots = await watchReport(await url);
    const judgments = snapshots.at(-1)!.state.judgments!;

    const semanticMeta = metasOf(judgments[0]!)[0]!;
    expect(semanticMeta).toMatchObject({ triggered: true, verdict: "true", semanticTrigger: true });
    const semanticClause = clausesOf(semanticMeta)[0]!;
    expect(semanticClause).toMatchObject({
      role: "check",
      kind: "semantic",
      checkType: null,
      verdict: "true",
      reasoning: "The answer cites the primary source.",
    });
    const semanticCitations = semanticClause.citations as Array<{
      description: string | null;
      event: { action: string } | null;
    }>;
    expect(semanticCitations[0]!.description).toBe("the primary source read");
    expect(semanticCitations[0]!.event).toMatchObject({ action: "open_url_result" });

    // The declined semantic trigger leaves one explanatory trigger clause.
    const untriggeredMeta = metasOf(judgments[1]!)[0]!;
    expect(untriggeredMeta).toMatchObject({
      triggered: false,
      verdict: "na",
      naReason: "not_applicable",
    });
    const triggerClause = clausesOf(untriggeredMeta)[0]!;
    expect(triggerClause).toMatchObject({
      role: "trigger",
      kind: "semantic",
      reasoning: "The run is an email rewrite, not a tax question.",
    });

    await result;
  });

  it("rejects an ack posted before the report is ready", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { url, result } = startReport({
      judgeCase: async (trajectoryCase) => {
        await gate;
        return offlineJudge(trajectoryCase);
      },
    });
    const client = await ReportClient.connect(await url);

    try {
      expect(await client.ack()).toBe(409);
      release();
      await nextOfType(client, "report");
      expect(await client.ack()).toBe(200);
      await result;
    } finally {
      client.close();
    }
  });

  it("requires the one-time token on every route", async () => {
    const { url, result } = startReport();
    const reportUrl = new URL(await url);

    const page = await fetch(`${reportUrl.origin}/`);
    expect(page.status).toBe(403);
    const events = await fetch(`${reportUrl.origin}/events?token=wrong`);
    expect(events.status).toBe(403);
    const ack = await fetch(`${reportUrl.origin}/ack?token=wrong`, { method: "POST" });
    expect(ack.status).toBe(403);
    const withToken = await fetch(reportUrl);
    expect(withToken.status).toBe(200);
    expect(await withToken.text()).toContain("behavior-judge");

    await watchReport(reportUrl.href);
    await result;
  });

  it("pushes an error state and shuts the server down when judging fails", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { url, result } = startReport({
      judgeCase: async () => {
        await gate;
        throw new Error("gateway down");
      },
    });
    const client = await ReportClient.connect(await url);

    try {
      const first = await client.next();
      expect(first.state.type).toBe("judging");
      // Attach the rejection handler before releasing the failure, so the
      // run's rejection is never momentarily unhandled.
      const rejection = expect(result).rejects.toThrow("gateway down");
      release();
      const failed = await nextOfType(client, "error");
      expect(failed.state.message).toBe("gateway down");
      await rejection;
      await expect(fetch(new URL(await url))).rejects.toThrow();
    } finally {
      client.close();
    }
  });
});
