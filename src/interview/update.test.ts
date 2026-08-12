import { describe, expect, it } from "vite-plus/test";

import { splitSpecSections, type InterviewDeps } from "./generate.js";
import type { JudgeIr, MetaBehaviorIr } from "../core/ir.js";
import { taxCase } from "../core/taxFixtures.js";
import {
  buildTriageMessages,
  buildUpdateProposalMessages,
  computeSectionDelta,
  parseTriageResult,
  parseUpdateProposal,
  planUpdate,
  quoteInSection,
  runUpdateInterview,
  type UpdateTarget,
} from "./update.js";

const SECTION_1_HEADING = "Read the tax research skill before beginning source research";
const SECTION_1_BODY =
  "When beginning source research to answer a tax question, the agent first reads the tax research skill, before searching or opening a source.";
const SECTION_2_HEADING = "Consult primary sources before answering";
const SECTION_2_BODY =
  "Before deciding on the answer, it reads the relevant primary source and bases its conclusion on that source.";

const baseBody = `# Primary-source tax research

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

const trajectories = [taxCase("secondary-then-primary").trajectory];

function scriptedDeps(
  completions: string[],
  answers: string[],
): {
  deps: InterviewDeps;
  output: string[];
  asked: string[];
  completionCalls: unknown[];
} {
  const output: string[] = [];
  const asked: string[] = [];
  const completionCalls: unknown[] = [];
  const completionQueue = [...completions];
  const answerQueue = [...answers];
  return {
    output,
    asked,
    completionCalls,
    deps: {
      complete: (messages) => {
        completionCalls.push(messages);
        const next = completionQueue.shift();
        return next === undefined
          ? Promise.reject(new Error("unexpected LLM call"))
          : Promise.resolve(next);
      },
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(answerQueue.shift() ?? "");
      },
      write: (line) => {
        output.push(line);
      },
    },
  };
}

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

describe("planUpdate", () => {
  it("maps identical sections to unchanged entries", () => {
    const plan = planUpdate(existingIr(), splitSpecSections(baseBody));
    expect(plan.entries.map((entry) => entry.kind)).toEqual(["unchanged", "unchanged"]);
    expect(plan.removed).toEqual([]);
  });

  it("classifies edited, added, and removed sections", () => {
    const editedBody = `${baseBody.replace(SECTION_2_BODY, `${SECTION_2_BODY} It cites that source.`)}
## Brand new section

New rules here.
`;
    const plan = planUpdate(existingIr(), splitSpecSections(editedBody));
    expect(plan.entries.map((entry) => entry.kind)).toEqual(["unchanged", "changed", "added"]);

    const removedPlan = planUpdate(
      existingIr(),
      splitSpecSections(`## ${SECTION_1_HEADING}\n\n${SECTION_1_BODY}\n`),
    );
    expect(removedPlan.entries.map((entry) => entry.kind)).toEqual(["unchanged"]);
    expect(removedPlan.removed.map((meta) => meta.name)).toEqual([SECTION_2_HEADING]);
  });

  it("treats a renamed heading as removed plus added", () => {
    const renamedBody = baseBody.replace(
      `## ${SECTION_2_HEADING}`,
      "## Consult primary sources first",
    );
    const plan = planUpdate(existingIr(), splitSpecSections(renamedBody));
    expect(plan.entries[1]).toMatchObject({
      kind: "added",
      section: { heading: "Consult primary sources first" },
    });
    expect(plan.removed.map((meta) => meta.name)).toEqual([SECTION_2_HEADING]);
  });

  it("treats a meta without a recorded source as changed even when the text matches", () => {
    const ir = existingIr();
    delete ir.metaBehaviors[0]!.source;
    const plan = planUpdate(ir, splitSpecSections(baseBody));
    expect(plan.entries.map((entry) => entry.kind)).toEqual(["changed", "unchanged"]);
  });
});

describe("quoteInSection", () => {
  it("matches verbatim quotes with flattened whitespace", () => {
    expect(quoteInSection("reads the relevant primary source", SECTION_2_BODY)).toBe(true);
    expect(quoteInSection("reads   the relevant\nprimary source", SECTION_2_BODY)).toBe(true);
    expect(quoteInSection("reads the primary source", SECTION_2_BODY)).toBe(false);
  });
});

describe("computeSectionDelta", () => {
  it("carries everything when the proposal repeats the existing meta", () => {
    const delta = computeSectionDelta(meta2(), meta2(), SECTION_2_BODY);
    expect(delta.triggerCarried).toBe(true);
    expect(delta.carriedChecks).toEqual(meta2().checks);
    expect(delta.droppedChecks).toEqual([]);
    expect(delta.newChecks).toEqual([]);
    expect(delta.carriedSemanticChecks).toEqual(meta2().semanticChecks);
    expect(delta.newSemanticChecks).toEqual([]);
  });

  it("discards proposal drift for a surviving quote instead of treating it as new", () => {
    const drifted = meta2();
    drifted.checks = [
      {
        type: "required",
        quote: "Before deciding on the answer, it reads the relevant primary source",
        match: { action: "open_url" },
      },
    ];
    const delta = computeSectionDelta(meta2(), drifted, SECTION_2_BODY);
    expect(delta.carriedChecks).toEqual(meta2().checks);
    expect(delta.newChecks).toEqual([]);
  });

  it("drops clauses whose quotes vanished and surfaces proposal clauses with new quotes", () => {
    const rewrittenBody =
      "Before deciding on the answer, it reads at least two relevant primary sources and bases its conclusion on that source.";
    const proposal = meta2();
    proposal.checks = [
      {
        type: "count",
        quote: "it reads at least two relevant primary sources",
        match: { action: "open_url_result", metadata: { sourceType: "primary" } },
        min: 2,
      },
    ];
    const delta = computeSectionDelta(meta2(), proposal, rewrittenBody);
    expect(delta.droppedChecks).toEqual(meta2().checks);
    expect(delta.carriedChecks).toEqual([]);
    expect(delta.newChecks).toEqual(proposal.checks);
    expect(delta.carriedSemanticChecks).toEqual(meta2().semanticChecks);
  });

  it("compares predicate triggers by match only and semantic triggers by description", () => {
    const reworded = meta1();
    reworded.trigger = {
      description: "Source research begins.",
      match: [{ action: "web_search" }, { action: "open_url" }],
    };
    expect(computeSectionDelta(meta1(), reworded, SECTION_1_BODY).triggerCarried).toBe(true);

    const rewordedSemantic = meta2();
    rewordedSemantic.trigger = { description: "The agent answers.", semantic: true };
    expect(computeSectionDelta(meta2(), rewordedSemantic, SECTION_2_BODY).triggerCarried).toBe(
      false,
    );
  });
});

describe("parseUpdateProposal", () => {
  const targets: UpdateTarget[] = [
    { section: { heading: SECTION_2_HEADING, body: SECTION_2_BODY }, previous: meta2() },
  ];

  it("returns proposals keyed by meta-behavior name", () => {
    const response = JSON.stringify({
      metaBehaviors: [
        {
          name: SECTION_2_HEADING,
          trigger: { description: "The agent answers a tax question.", semantic: true },
          checks: meta2().checks,
          semanticChecks: [],
        },
      ],
    });
    const proposals = parseUpdateProposal(response, "primary-source-tax-research", targets);
    expect([...proposals.keys()]).toEqual([SECTION_2_HEADING]);
  });

  it("rejects a proposal covering the wrong meta-behaviors", () => {
    const response = JSON.stringify({
      metaBehaviors: [
        {
          name: "Some other meta",
          trigger: { description: "Whatever.", semantic: true },
          checks: [],
          semanticChecks: [{ quote: "bases its conclusion on that source", question: "Q?" }],
        },
      ],
    });
    expect(() => parseUpdateProposal(response, "primary-source-tax-research", targets)).toThrow(
      /Missing: Consult primary sources before answering.*Unexpected: Some other meta/,
    );
  });

  it("rejects a quote that is not a verbatim excerpt of the section", () => {
    const response = JSON.stringify({
      metaBehaviors: [
        {
          name: SECTION_2_HEADING,
          trigger: { description: "The agent answers a tax question.", semantic: true },
          checks: [
            {
              type: "required",
              quote: "consults the primary source first",
              match: { action: "open_url" },
            },
          ],
          semanticChecks: [],
        },
      ],
    });
    expect(() => parseUpdateProposal(response, "primary-source-tax-research", targets)).toThrow(
      /not a verbatim excerpt/,
    );
  });
});

describe("triage messages and parsing", () => {
  it("includes both section versions and the carried clauses", () => {
    const messages = buildTriageMessages({
      metaName: SECTION_2_HEADING,
      previousSection: SECTION_2_BODY,
      currentSection: `${SECTION_2_BODY} Edited.`,
      items: [{ id: "check-1", description: "predicate check {...}" }],
    });
    expect(messages[0]!.content).toContain("re_ask");
    expect(messages[1]!.content).toContain("Section text before the edit:");
    expect(messages[1]!.content).toContain(`${SECTION_2_BODY} Edited.`);
    expect(messages[1]!.content).toContain("check-1");
  });

  it("parses verdicts for exactly the listed ids", () => {
    const result = parseTriageResult(
      triageResponse(
        { trigger: "unaffected", "check-1": "re_ask" },
        { "check-1": "term redefined" },
      ),
      ["trigger", "check-1"],
    );
    expect(result.get("trigger")).toEqual({ reAsk: false, reason: "scripted reason" });
    expect(result.get("check-1")).toEqual({ reAsk: true, reason: "term redefined" });
  });

  it("rejects unknown, duplicate, and missing ids, bad verdicts, and missing reasons", () => {
    expect(() => parseTriageResult(triageResponse({ bogus: "unaffected" }), ["trigger"])).toThrow(
      /not a listed clause id/,
    );
    expect(() =>
      parseTriageResult(
        JSON.stringify({
          items: [
            { id: "trigger", verdict: "unaffected", reason: "r" },
            { id: "trigger", verdict: "re_ask", reason: "r" },
          ],
        }),
        ["trigger"],
      ),
    ).toThrow(/more than once/);
    expect(() =>
      parseTriageResult(triageResponse({ trigger: "unaffected" }), ["trigger", "check-1"]),
    ).toThrow(/missing ids: check-1/);
    expect(() =>
      parseTriageResult(
        JSON.stringify({ items: [{ id: "trigger", verdict: "maybe", reason: "r" }] }),
        ["trigger"],
      ),
    ).toThrow(/must be "unaffected" or "re_ask"/);
    expect(() =>
      parseTriageResult(JSON.stringify({ items: [{ id: "trigger", verdict: "re_ask" }] }), [
        "trigger",
      ]),
    ).toThrow(/reason/);
  });
});

describe("buildUpdateProposalMessages", () => {
  it("scopes the request to the listed sections and includes previous IRs", () => {
    const messages = buildUpdateProposalMessages({
      behaviorName: "primary-source-tax-research",
      behaviorBody: baseBody,
      targets: [
        {
          section: { heading: SECTION_2_HEADING, body: `${SECTION_2_BODY} Edited.` },
          previous: meta2(),
        },
        { section: { heading: "Brand new section", body: "New rules here." } },
      ],
      vocabulary: [],
    });
    expect(messages[0]!.content).toContain("UPDATE MODE");
    const user = messages[1]!.content;
    expect(user).toContain(`Section "${SECTION_2_HEADING}" (edited)`);
    expect(user).toContain(`Previous meta-behavior IR for "${SECTION_2_HEADING}"`);
    expect(user).toContain('Section "Brand new section" (new)');
    // The previous IR context omits the source bookkeeping field.
    expect(user).not.toContain("source:");
  });
});

describe("runUpdateInterview", () => {
  const citesSentence = "It cites that primary source in its final answer.";
  const editedSection2 = `${SECTION_2_BODY} ${citesSentence}`;
  const editedBody = baseBody.replace(SECTION_2_BODY, editedSection2);

  const proposalWithCitesCheck = JSON.stringify({
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
  const allUnaffected = triageResponse({
    trigger: "unaffected",
    "check-1": "unaffected",
    "semantic-1": "unaffected",
  });

  function runUpdate(body: string, existing: JudgeIr, completions: string[], answers: string[]) {
    const scripted = scriptedDeps(completions, answers);
    return runUpdateInterview(
      {
        behaviorName: "primary-source-tax-research",
        behaviorBody: body,
        existing,
        trajectories,
      },
      scripted.deps,
    ).then((ir) => ({ ir, ...scripted }));
  }

  it("requires at least one trajectory", async () => {
    const { deps } = scriptedDeps([], []);
    await expect(
      runUpdateInterview(
        {
          behaviorName: "primary-source-tax-research",
          behaviorBody: baseBody,
          existing: existingIr(),
          trajectories: [],
        },
        deps,
      ),
    ).rejects.toThrow(/at least one sample trajectory/);
  });

  it("requires H2 sections", async () => {
    const { deps } = scriptedDeps([], []);
    await expect(
      runUpdateInterview(
        {
          behaviorName: "primary-source-tax-research",
          behaviorBody: "# Title\n\nNo headings here.\n",
          existing: existingIr(),
          trajectories,
        },
        deps,
      ),
    ).rejects.toThrow(/H2 sections/);
  });

  it("carries an unchanged spec over with zero LLM calls and only the final confirm", async () => {
    const { ir, asked, completionCalls, output } = await runUpdate(
      baseBody,
      existingIr(),
      [],
      ["y"],
    );
    expect(completionCalls).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(output.some((line) => line.includes("unchanged; carried over"))).toBe(true);
    expect(ir!.metaBehaviors).toEqual([meta1(), meta2()]);
  });

  it("interviews only the delta of a changed section and batch-confirms the carried rest", async () => {
    const { ir, asked, completionCalls, output } = await runUpdate(
      editedBody,
      existingIr(),
      [proposalWithCitesCheck, allUnaffected],
      ["y", "y", "y"], // batch confirm, new semantic check, final confirm
    );

    expect(completionCalls).toHaveLength(2);
    expect(asked).toHaveLength(3);
    expect(output.some((line) => line.includes("section changed"))).toBe(true);
    expect(output.some((line) => line.includes("Carrying over 3 clause(s)"))).toBe(true);

    // Meta 1 is untouched; meta 2 keeps its carried clauses and gains the new one.
    expect(ir!.metaBehaviors[0]).toEqual(meta1());
    const updated = ir!.metaBehaviors[1]!;
    expect(updated.checks).toEqual(meta2().checks);
    expect(updated.semanticChecks.map((check) => check.quote)).toEqual([
      "bases its conclusion on that source",
      "It cites that primary source in its final answer",
    ]);
    expect(updated.source).toBe(editedSection2);
  });

  it("re-asks a triage-flagged clause individually with the reason", async () => {
    const flagged = triageResponse(
      { trigger: "unaffected", "check-1": "re_ask", "semantic-1": "unaffected" },
      { "check-1": "the edit may redefine what counts as a primary source" },
    );
    const { ir, asked, output } = await runUpdate(
      editedBody,
      existingIr(),
      [proposalWithCitesCheck, flagged],
      ["y", "y", "y", "y"], // batch confirm, re-asked check, new semantic check, final confirm
    );

    expect(asked).toHaveLength(4);
    expect(
      output.some((line) =>
        line.includes(
          "Re-asking — this clause needs re-review: the edit may redefine what counts as a primary source",
        ),
      ),
    ).toBe(true);
    expect(ir!.metaBehaviors[1]!.checks).toEqual(meta2().checks);
  });

  it("falls through to individual review when the batch confirm is declined", async () => {
    const { ir, asked, output } = await runUpdate(
      editedBody,
      existingIr(),
      [proposalWithCitesCheck, allUnaffected],
      ["n", "y", "y", "y", "y", "y"], // decline batch; trigger, check, semantic; new semantic; final
    );

    expect(asked).toHaveLength(6);
    expect(asked[1]).toContain("[e] edit description");
    expect(output.some((line) => line.includes("Re-asking"))).toBe(false);
    expect(ir!.metaBehaviors[1]!.checks).toEqual(meta2().checks);
    expect(ir!.metaBehaviors[1]!.semanticChecks).toHaveLength(2);
  });

  it("drops a clause whose quoted sentence vanished and asks about its replacement", async () => {
    const rewrittenSection =
      "Before deciding on the answer, it reads at least two relevant primary sources and bases its conclusion on that source.";
    const rewrittenBody = baseBody.replace(SECTION_2_BODY, rewrittenSection);
    const countCheck = {
      type: "count",
      quote: "it reads at least two relevant primary sources",
      match: { action: "open_url_result", metadata: { sourceType: "primary" } },
      min: 2,
    };
    const proposal = JSON.stringify({
      metaBehaviors: [
        {
          name: SECTION_2_HEADING,
          trigger: { description: "The agent answers a tax question.", semantic: true },
          checks: [countCheck],
          semanticChecks: meta2().semanticChecks,
        },
      ],
    });
    const triage = triageResponse({ trigger: "unaffected", "semantic-1": "unaffected" });

    const { ir, asked, output } = await runUpdate(
      rewrittenBody,
      existingIr(),
      [proposal, triage],
      ["y", "y", "y"], // batch confirm, new count check, final confirm
    );

    expect(asked).toHaveLength(3);
    expect(
      output.some((line) =>
        line.includes(
          'note: dropped ordering check "Before deciding on the answer, it reads the relevant primary source"',
        ),
      ),
    ).toBe(true);
    expect(ir!.metaBehaviors[1]!.checks).toEqual([countCheck]);
    expect(ir!.metaBehaviors[1]!.semanticChecks).toEqual(meta2().semanticChecks);
  });

  it("interviews an added section like generate and records its source", async () => {
    const addedBody = `${baseBody}
## Cite the primary source

Every final answer cites the primary source it relies on.
`;
    const proposal = JSON.stringify({
      metaBehaviors: [
        {
          name: "Cite the primary source",
          trigger: {
            description: "The agent gives a final answer.",
            match: { action: "final_answer" },
          },
          checks: [
            {
              type: "required",
              quote: "cites the primary source",
              match: { action: "final_answer" },
            },
          ],
          semanticChecks: [],
        },
      ],
    });

    const { ir, asked, completionCalls } = await runUpdate(
      addedBody,
      existingIr(),
      [proposal],
      ["y", "y", "y"], // trigger, check, final confirm
    );

    expect(completionCalls).toHaveLength(1);
    expect(asked).toHaveLength(3);
    expect(ir!.metaBehaviors).toHaveLength(3);
    expect(ir!.metaBehaviors[2]).toMatchObject({
      name: "Cite the primary source",
      source: "Every final answer cites the primary source it relies on.",
    });
  });

  it("drops the meta of a removed section with a notice", async () => {
    const removedBody = `# Primary-source tax research

## ${SECTION_1_HEADING}

${SECTION_1_BODY}
`;
    const { ir, asked, completionCalls, output } = await runUpdate(
      removedBody,
      existingIr(),
      [],
      ["y"],
    );

    expect(completionCalls).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(
      output.some((line) =>
        line.includes(`note: "${SECTION_2_HEADING}" removed — its section no longer appears`),
      ),
    ).toBe(true);
    expect(ir!.metaBehaviors.map((meta) => meta.name)).toEqual([SECTION_1_HEADING]);
  });

  it("offers to keep the previous trigger when the proposal changes it", async () => {
    const editedSection1 = `${SECTION_1_BODY} This also applies when consulting internal tax databases.`;
    const body = baseBody.replace(SECTION_1_BODY, editedSection1);
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
    const triage = triageResponse({ "check-1": "unaffected" });

    const { ir, asked, output } = await runUpdate(
      body,
      existingIr(),
      [proposal, triage],
      ["p", "y", "y"], // keep previous trigger, batch confirm, final confirm
    );

    expect(asked).toHaveLength(3);
    expect(output.some((line) => line === "Trigger changed.")).toBe(true);
    expect(ir!.metaBehaviors[0]!.trigger).toEqual(meta1().trigger);
    expect(ir!.metaBehaviors[0]!.checks).toEqual(meta1().checks);
    expect(ir!.metaBehaviors[0]!.source).toBe(editedSection1);
  });

  it("re-reviews every carried clause when the meta has no recorded source", async () => {
    const ir = existingIr();
    delete ir.metaBehaviors[0]!.source;
    const proposal = JSON.stringify({
      metaBehaviors: [
        {
          name: SECTION_1_HEADING,
          trigger: meta1().trigger,
          checks: meta1().checks,
          semanticChecks: [],
        },
      ],
    });

    const result = await runUpdate(baseBody, ir, [proposal], ["y", "y", "y"]); // trigger, check, final
    expect(result.completionCalls).toHaveLength(1); // proposal only; no triage without old text
    expect(result.asked).toHaveLength(3);
    expect(
      result.output.some((line) => line.includes("did not record the previous section text")),
    ).toBe(true);
    expect(result.ir!.metaBehaviors[0]).toEqual(meta1()); // source recorded going forward
  });

  it("retries a malformed triage response once with the error appended", async () => {
    const { ir, completionCalls } = await runUpdate(
      editedBody,
      existingIr(),
      [proposalWithCitesCheck, "not json at all", allUnaffected],
      ["y", "y", "y"],
    );
    expect(completionCalls).toHaveLength(3);
    expect(ir!.metaBehaviors[1]!.semanticChecks).toHaveLength(2);
  });

  it("returns undefined when the final confirmation is declined", async () => {
    const { ir } = await runUpdate(baseBody, existingIr(), [], ["n"]);
    expect(ir).toBeUndefined();
  });
});
