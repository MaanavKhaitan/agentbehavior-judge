import { describe, expect, it } from "vite-plus/test";

import { serializeIr, type JudgeIr } from "./ir.js";
import { taxCase } from "./taxFixtures.js";
import { runWebInterview } from "./webInterview.js";
import { driveConnected, driveInterview, InterviewClient } from "./webInterviewTestClient.js";

const behaviorBody = `# Primary-source tax research

## Read the tax research skill before beginning source research

When beginning source research to answer a tax question, the agent first reads the tax research skill, before searching or opening a source.

## Consult primary sources before answering

Before deciding on the answer, it reads the relevant primary source and bases its conclusion on that source.
`;

const trajectories = [
  taxCase("secondary-then-primary").trajectory,
  taxCase("correct-without-research").trajectory,
];

const proposal = {
  metaBehaviors: [
    {
      name: "Read the tax research skill before beginning source research",
      trigger: {
        description: "The agent begins source research.",
        match: [{ action: "web_search" }, { action: "open_url" }],
      },
      checks: [
        {
          type: "ordering",
          quote: "the agent first reads the tax research skill",
          first: { action: "read_skill" },
          before: [{ action: "web_search" }, { action: "open_url" }],
        },
      ],
      semanticChecks: [],
    },
    {
      name: "Consult primary sources before answering",
      trigger: { description: "The agent answers a tax question.", semantic: true },
      checks: [
        {
          type: "required",
          quote: "it reads the relevant primary source",
          match: { action: "open_url_result", metadata: { sourceType: "primary" } },
        },
      ],
      semanticChecks: [
        {
          quote: "bases its conclusion on that source",
          question: "Does the final answer base its conclusion on the primary source?",
        },
      ],
    },
  ],
};

// Step order for this proposal (both metas keep their H2 names, so there are
// no name steps): 0 trigger m1, 1 check m1, 2 trigger m2, 3 check m2,
// 4 semantic check m2, 5 confirm.
const ACCEPT_ALL = [
  { kind: "accept" },
  { kind: "accept" },
  { kind: "accept" },
  { kind: "accept" },
  { kind: "accept" },
  { kind: "save" },
];

function startInterview(overrides?: { complete?: () => Promise<string> }) {
  const written: string[] = [];
  const logs: string[] = [];
  let resolveUrl!: (url: string) => void;
  const url = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const result = runWebInterview({
    input: { behaviorName: "primary-source-tax-research", behaviorBody, trajectories },
    complete: overrides?.complete ?? (() => Promise.resolve(JSON.stringify(proposal))),
    outPath: "/virtual/judge.yaml",
    writeIr: (ir: JudgeIr) => {
      written.push(serializeIr(ir));
      return Promise.resolve("/virtual/judge.yaml");
    },
    log: (line) => {
      logs.push(line);
    },
    openBrowser: (interviewUrl) => {
      resolveUrl(interviewUrl);
    },
  });
  return { url, result, written, logs };
}

describe("runWebInterview", () => {
  it("drives an accept-all interview to a written judge", async () => {
    const { url, result, written, logs } = startInterview();

    const finalSnapshot = await driveInterview(await url, ACCEPT_ALL);

    expect(finalSnapshot.state).toMatchObject({ type: "done", written: "/virtual/judge.yaml" });
    const ir = await result;
    expect(ir).toBeDefined();
    expect(ir!.metaBehaviors.map((meta) => meta.name)).toEqual([
      "Read the tax research skill before beginning source research",
      "Consult primary sources before answering",
    ]);
    expect(written).toHaveLength(1);
    expect(logs.some((line) => line.startsWith("Interview running at http://127.0.0.1:"))).toBe(
      true,
    );
  });

  it("streams structured step payloads for every card the page renders", async () => {
    const { url, result } = startInterview();
    const client = await InterviewClient.connect(await url);

    try {
      const trigger1 = await client.nextStep();
      expect(trigger1.state.stepId).toBe(0);
      expect(trigger1.state.canGoBack).toBe(false);
      expect(trigger1.state.step).toMatchObject({
        kind: "trigger",
        metaName: "Read the tax research skill before beginning source research",
        semantic: false,
        match: [{ action: "web_search" }, { action: "open_url" }],
        position: { metaIndex: 0, metaCount: 2 },
      });
      const triggerEvidence = trigger1.state.step!.evidence as {
        sample: { actor: string; action: string; content: string };
      };
      expect(triggerEvidence.sample.action).toBe("web_search");
      expect(triggerEvidence.sample.actor).toBe("agent");
      await client.answer(0, { kind: "accept" });

      const check1 = await client.nextStep();
      expect(check1.state.canGoBack).toBe(true);
      expect(check1.state.step).toMatchObject({
        kind: "check",
        check: { type: "ordering", first: { action: "read_skill" } },
        position: { metaIndex: 0, metaCount: 2, itemIndex: 0, itemCount: 1 },
      });
      const checkEvidence = check1.state.step!.evidence as Array<{ role: string }>;
      expect(checkEvidence.map((entry) => entry.role)).toEqual(["first", "before"]);
      await client.answer(1, { kind: "accept" });

      const trigger2 = await client.nextStep();
      expect(trigger2.state.step).toMatchObject({
        kind: "trigger",
        semantic: true,
        match: null,
        evidence: null,
      });
      await client.answer(2, { kind: "accept" });

      const check2 = await client.nextStep();
      const requiredEvidence = check2.state.step!.evidence as Array<{
        sample: { metadata: Record<string, string> };
      }>;
      expect(requiredEvidence[0]!.sample.metadata).toEqual({ sourceType: "primary" });
      await client.answer(3, { kind: "accept" });

      const semantic = await client.nextStep();
      expect(semantic.state.step).toMatchObject({
        kind: "semanticCheck",
        quote: "bases its conclusion on that source",
        demoted: false,
      });
      await client.answer(4, { kind: "accept" });

      const confirm = await client.nextStep();
      expect(confirm.state.step).toMatchObject({ kind: "confirm", outPath: "/virtual/judge.yaml" });
      const summary = confirm.state.step!.summary as Array<Record<string, unknown>>;
      expect(summary).toHaveLength(2);
      expect(summary[1]).toMatchObject({
        semanticTrigger: true,
        triggerDescription: "The agent answers a tax question.",
        checkCount: 1,
        semanticCheckCount: 1,
        checks: [{ type: "required", quote: "it reads the relevant primary source" }],
        semanticChecks: [
          { question: "Does the final answer base its conclusion on the primary source?" },
        ],
      });
      expect(confirm.state.step!.yaml).toContain("behavior: primary-source-tax-research");
      await client.answer(5, { kind: "save" });

      const done = await client.next();
      expect(done.state).toMatchObject({ type: "done", written: "/virtual/judge.yaml" });
      await result;
    } finally {
      client.close();
    }
  });

  it("replays recorded answers when the user goes back, without re-asking the model", async () => {
    let completions = 0;
    const { url, result } = startInterview({
      complete: () => {
        completions += 1;
        return Promise.resolve(JSON.stringify(proposal));
      },
    });
    const client = await InterviewClient.connect(await url);

    try {
      const trigger1 = await client.nextStep();
      expect(trigger1.state.stepId).toBe(0);
      await client.answer(0, { kind: "accept" });

      const check1 = await client.nextStep();
      expect(check1.state.stepId).toBe(1);
      expect(await client.back()).toBe(200);

      const replayed = await client.nextStep();
      expect(replayed.state.stepId).toBe(0);
      expect(replayed.state.canGoBack).toBe(false);
      expect(replayed.state.step).toMatchObject({ kind: "trigger", semantic: false });

      await client.answer(0, { kind: "edit", description: "reads or searches sources" });
      const done = await driveConnected(client, ACCEPT_ALL.slice(1));
      expect(done.state.type).toBe("done");

      const ir = await result;
      expect(ir!.metaBehaviors[0]!.trigger.description).toBe("Reads or searches sources");
      expect(completions).toBe(1);
    } finally {
      client.close();
    }
  });

  it("cancelling the final confirmation writes nothing", async () => {
    const { url, result, written } = startInterview();

    const finalSnapshot = await driveInterview(await url, [
      ...ACCEPT_ALL.slice(0, 5),
      { kind: "cancel" },
    ]);

    expect(finalSnapshot.state).toMatchObject({ type: "done", written: null });
    expect(await result).toBeUndefined();
    expect(written).toHaveLength(0);
  });

  it("requires the one-time token on every route", async () => {
    const { url, result } = startInterview();
    const interviewUrl = new URL(await url);

    const page = await fetch(`${interviewUrl.origin}/`);
    expect(page.status).toBe(403);
    const events = await fetch(`${interviewUrl.origin}/events?token=wrong`);
    expect(events.status).toBe(403);
    const answer = await fetch(`${interviewUrl.origin}/answer?token=wrong`, { method: "POST" });
    expect(answer.status).toBe(403);
    const withToken = await fetch(interviewUrl);
    expect(withToken.status).toBe(200);
    expect(await withToken.text()).toContain("behavior-judge");

    await driveInterview(interviewUrl.href, [...ACCEPT_ALL.slice(0, 5), { kind: "cancel" }]);
    await result;
  });

  it("rejects stale, malformed, and step-mismatched answers without advancing", async () => {
    const { url, result } = startInterview();
    const client = await InterviewClient.connect(await url);

    try {
      const trigger1 = await client.nextStep();
      expect(trigger1.state.stepId).toBe(0);
      expect(await client.answer(7, { kind: "accept" })).toBe(409);
      expect(await client.answer(0, { kind: "frobnicate" })).toBe(400);
      expect(await client.answer(0, { kind: "edit" })).toBe(400);
      expect(await client.back()).toBe(409);
      expect(await client.answer(0, { kind: "accept" })).toBe(200);

      await client.nextStep();
      await client.answer(1, { kind: "accept" });

      // forceSemantic is meaningless for an already-semantic trigger.
      const trigger2 = await client.nextStep();
      expect(trigger2.state.stepId).toBe(2);
      expect(await client.answer(2, { kind: "forceSemantic" })).toBe(400);
      expect(await client.answer(2, { kind: "accept" })).toBe(200);

      const done = await driveConnected(client, [
        { kind: "accept" },
        { kind: "accept" },
        { kind: "cancel" },
      ]);
      expect(done.state.type).toBe("done");
      await result;
    } finally {
      client.close();
    }
  });

  it("propagates proposal failures and shuts the server down", async () => {
    const { url, result } = startInterview({
      complete: () => Promise.reject(new Error("gateway down")),
    });

    await expect(result).rejects.toThrow("gateway down");
    const interviewUrl = new URL(await url);
    await expect(fetch(interviewUrl)).rejects.toThrow();
  });
});
