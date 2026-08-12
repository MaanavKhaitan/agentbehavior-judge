import { describe, expect, it } from "vite-plus/test";

import { serializeIr, type JudgeIr, type MetaBehaviorIr } from "./ir.js";
import { taxCase } from "./taxFixtures.js";
import { runWebInterview, runWebUpdateInterview } from "./webInterview.js";
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
      expect(confirm.state.step).toMatchObject({
        kind: "confirm",
        outPath: "/virtual/judge.yaml",
        // Plain generate has no update plan; the page keeps the generic copy.
        update: null,
      });
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

// ---------------------------------------------------------------------------
// Update mode (`generate --web --update`): the same server around the update
// driver. Fixtures mirror update.test.ts.
// ---------------------------------------------------------------------------

const SECTION_1_HEADING = "Read the tax research skill before beginning source research";
const SECTION_1_BODY =
  "When beginning source research to answer a tax question, the agent first reads the tax research skill, before searching or opening a source.";
const SECTION_2_HEADING = "Consult primary sources before answering";
const SECTION_2_BODY =
  "Before deciding on the answer, it reads the relevant primary source and bases its conclusion on that source.";

const updateBaseBody = `# Primary-source tax research

## ${SECTION_1_HEADING}

${SECTION_1_BODY}

## ${SECTION_2_HEADING}

${SECTION_2_BODY}
`;

function meta1(): MetaBehaviorIr {
  return {
    name: SECTION_1_HEADING,
    trigger: {
      description: "The agent begins source research.",
      match: [{ action: "web_search" }, { action: "open_url" }],
    },
    checks: [
      {
        type: "ordering",
        quote: "the agent first reads the tax research skill, before searching or opening a source",
        first: { action: "read_skill" },
        before: [{ action: "web_search" }, { action: "open_url" }],
      },
    ],
    semanticChecks: [],
    source: SECTION_1_BODY,
  };
}

function meta2(): MetaBehaviorIr {
  return {
    name: SECTION_2_HEADING,
    trigger: { description: "The agent answers a tax question.", semantic: true },
    checks: [
      {
        type: "ordering",
        quote: "Before deciding on the answer, it reads the relevant primary source",
        first: { action: "open_url_result", metadata: { sourceType: "primary" } },
        before: { action: "final_answer" },
      },
    ],
    semanticChecks: [
      {
        quote: "bases its conclusion on that source",
        question: "Does the final answer base its conclusion on the primary source the agent read?",
      },
    ],
    source: SECTION_2_BODY,
  };
}

function existingIr(): JudgeIr {
  return {
    version: 1,
    behavior: "primary-source-tax-research",
    metaBehaviors: [meta1(), meta2()],
  };
}

const CITES_SENTENCE = "It cites that primary source in its final answer.";
const editedSection2 = `${SECTION_2_BODY} ${CITES_SENTENCE}`;
const editedBody = updateBaseBody.replace(SECTION_2_BODY, editedSection2);

const updateProposal = JSON.stringify({
  metaBehaviors: [
    {
      name: SECTION_2_HEADING,
      trigger: { description: "The agent answers a tax question.", semantic: true },
      checks: meta2().checks,
      semanticChecks: [
        ...meta2().semanticChecks,
        {
          quote: "It cites that primary source in its final answer",
          question: "Does the final answer cite the primary source?",
        },
      ],
    },
  ],
});

function triageResponse(
  verdicts: Record<string, "unaffected" | "re_ask">,
  reasons: Record<string, string> = {},
): string {
  return JSON.stringify({
    items: Object.entries(verdicts).map(([id, verdict]) => ({
      id,
      verdict,
      reason: reasons[id] ?? "scripted reason",
    })),
  });
}

function startUpdateInterview(options: { body: string; existing: JudgeIr; completions: string[] }) {
  const written: string[] = [];
  const logs: string[] = [];
  const completionCalls: unknown[] = [];
  const completionQueue = [...options.completions];
  let resolveUrl!: (url: string) => void;
  const url = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const result = runWebUpdateInterview({
    input: {
      behaviorName: "primary-source-tax-research",
      behaviorBody: options.body,
      existing: options.existing,
      trajectories: [taxCase("secondary-then-primary").trajectory],
    },
    complete: (messages) => {
      completionCalls.push(messages);
      const next = completionQueue.shift();
      return next === undefined
        ? Promise.reject(new Error("unexpected LLM call"))
        : Promise.resolve(next);
    },
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
  return { url, result, written, logs, completionCalls };
}

describe("runWebUpdateInterview", () => {
  it("carries an unchanged spec straight to the confirm card with zero LLM calls", async () => {
    const { url, result, written, logs, completionCalls } = startUpdateInterview({
      body: updateBaseBody,
      existing: existingIr(),
      completions: [],
    });
    const client = await InterviewClient.connect(await url);

    try {
      const confirm = await client.nextStep();
      expect(confirm.state.stepId).toBe(0);
      expect(confirm.state.canGoBack).toBe(false);
      expect(confirm.state.step).toMatchObject({ kind: "confirm", outPath: "/virtual/judge.yaml" });
      // The page renders the explicit nothing-changed state from this.
      expect(confirm.state.step!.update).toEqual({
        unchanged: 2,
        changed: 0,
        added: 0,
        removed: [],
        hasChanges: false,
      });
      const summary = confirm.state.step!.summary as Array<Record<string, unknown>>;
      expect(summary.map((meta) => meta.status)).toEqual(["unchanged", "unchanged"]);
      await client.answer(0, { kind: "save" });

      const done = await client.next();
      expect(done.state).toMatchObject({ type: "done", written: "/virtual/judge.yaml" });

      const ir = await result;
      expect(ir!.metaBehaviors).toEqual([meta1(), meta2()]);
      expect(completionCalls).toEqual([]);
      expect(written).toHaveLength(1);
      expect(logs.some((line) => line.includes("unchanged; carried over"))).toBe(true);
    } finally {
      client.close();
    }
  });

  it("streams carried-batch, re-ask, and new-clause step payloads", async () => {
    const flagged = triageResponse(
      { trigger: "unaffected", "check-1": "re_ask", "semantic-1": "unaffected" },
      { "check-1": "the edit may redefine what counts as a primary source" },
    );
    const { url, result, written } = startUpdateInterview({
      body: editedBody,
      existing: existingIr(),
      completions: [updateProposal, flagged],
    });
    const client = await InterviewClient.connect(await url);

    try {
      const batch = await client.nextStep();
      expect(batch.state.step).toMatchObject({
        kind: "carriedBatch",
        metaName: SECTION_2_HEADING,
        position: { metaIndex: 1, metaCount: 2 },
      });
      const items = batch.state.step!.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        kind: "trigger",
        trigger: { semantic: true, description: "The agent answers a tax question." },
      });
      expect(items[1]).toMatchObject({
        kind: "semantic",
        quote: "bases its conclusion on that source",
      });
      await client.answer(0, { kind: "keep" });

      const reAsked = await client.nextStep();
      expect(reAsked.state.step).toMatchObject({
        kind: "check",
        check: { type: "ordering" },
        reAskReason: "the edit may redefine what counts as a primary source",
      });
      await client.answer(1, { kind: "accept" });

      const newSemantic = await client.nextStep();
      expect(newSemantic.state.step).toMatchObject({
        kind: "semanticCheck",
        quote: "It cites that primary source in its final answer",
        demoted: false,
        reAskReason: null,
      });
      await client.answer(2, { kind: "accept" });

      const confirm = await client.nextStep();
      expect(confirm.state.step).toMatchObject({
        kind: "confirm",
        update: { unchanged: 1, changed: 1, added: 0, hasChanges: true },
      });
      const summary = confirm.state.step!.summary as Array<Record<string, unknown>>;
      expect(summary.map((meta) => meta.status)).toEqual(["unchanged", "changed"]);
      await client.answer(3, { kind: "save" });

      const done = await client.next();
      expect(done.state.type).toBe("done");

      const ir = await result;
      const updated = ir!.metaBehaviors[1]!;
      expect(updated.checks).toEqual(meta2().checks);
      expect(updated.semanticChecks.map((check) => check.quote)).toEqual([
        "bases its conclusion on that source",
        "It cites that primary source in its final answer",
      ]);
      expect(updated.source).toBe(editedSection2);
      expect(written).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  it("offers keep-previous on a changed trigger and batch decline falls through", async () => {
    const editedSection1 = `${SECTION_1_BODY} This also applies when consulting internal tax databases.`;
    const body = updateBaseBody.replace(SECTION_1_BODY, editedSection1);
    const proposal = JSON.stringify({
      metaBehaviors: [
        {
          name: SECTION_1_HEADING,
          trigger: {
            description: "The agent begins source research.",
            match: [{ action: "web_search" }, { action: "open_url" }, { action: "db_lookup" }],
          },
          checks: meta1().checks,
          semanticChecks: [],
        },
      ],
    });
    const { url, result } = startUpdateInterview({
      body,
      existing: existingIr(),
      completions: [proposal, triageResponse({ "check-1": "unaffected" })],
    });
    const client = await InterviewClient.connect(await url);

    try {
      const changedTrigger = await client.nextStep();
      expect(changedTrigger.state.step).toMatchObject({
        kind: "changedTrigger",
        metaName: SECTION_1_HEADING,
        previous: { semantic: false, match: [{ action: "web_search" }, { action: "open_url" }] },
        proposed: {
          semantic: false,
          match: [{ action: "web_search" }, { action: "open_url" }, { action: "db_lookup" }],
        },
      });
      const evidence = changedTrigger.state.step!.evidence as { sample: { action: string } };
      expect(evidence.sample.action).toBe("web_search");
      // db_lookup never appears in the samples; the warning carries through.
      expect(changedTrigger.state.step!.unobserved).toEqual(["action `db_lookup`"]);
      await client.answer(0, { kind: "keepPrevious" });

      const batch = await client.nextStep();
      expect(batch.state.step).toMatchObject({ kind: "carriedBatch" });
      expect(batch.state.step!.items as unknown[]).toHaveLength(1);
      await client.answer(1, { kind: "review" });

      const check = await client.nextStep();
      // Individually reviewed via the declined batch, not a triage flag.
      expect(check.state.step).toMatchObject({ kind: "check", reAskReason: null });
      await client.answer(2, { kind: "accept" });

      const done = await driveConnected(client, [{ kind: "save" }]);
      expect(done.state.type).toBe("done");

      const ir = await result;
      expect(ir!.metaBehaviors[0]!.trigger).toEqual(meta1().trigger);
      expect(ir!.metaBehaviors[0]!.checks).toEqual(meta1().checks);
      expect(ir!.metaBehaviors[0]!.source).toBe(editedSection1);
    } finally {
      client.close();
    }
  });

  it("replays recorded answers on back without re-asking the model or the triage", async () => {
    const allUnaffected = triageResponse({
      trigger: "unaffected",
      "check-1": "unaffected",
      "semantic-1": "unaffected",
    });
    const { url, result, logs, completionCalls } = startUpdateInterview({
      body: editedBody,
      existing: existingIr(),
      completions: [updateProposal, allUnaffected],
    });
    const client = await InterviewClient.connect(await url);

    try {
      const batch = await client.nextStep();
      expect(batch.state.step).toMatchObject({ kind: "carriedBatch" });
      await client.answer(0, { kind: "keep" });

      const newSemantic = await client.nextStep();
      expect(newSemantic.state.stepId).toBe(1);
      expect(await client.back()).toBe(200);

      const replayed = await client.nextStep();
      expect(replayed.state.stepId).toBe(0);
      expect(replayed.state.step).toMatchObject({ kind: "carriedBatch" });
      await client.answer(0, { kind: "keep" });

      const done = await driveConnected(client, [{ kind: "accept" }, { kind: "save" }]);
      expect(done.state.type).toBe("done");

      await result;
      expect(completionCalls).toHaveLength(2);
      // The restarted driver re-emits its notes; replayed ones must not
      // duplicate in the terminal log.
      expect(logs.filter((line) => line.includes("— section changed."))).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  it("cancelling the final confirmation writes nothing", async () => {
    const { url, result, written } = startUpdateInterview({
      body: updateBaseBody,
      existing: existingIr(),
      completions: [],
    });

    const finalSnapshot = await driveInterview(await url, [{ kind: "cancel" }]);

    expect(finalSnapshot.state).toMatchObject({ type: "done", written: null });
    expect(await result).toBeUndefined();
    expect(written).toHaveLength(0);
  });
});
