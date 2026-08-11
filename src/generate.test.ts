import { describe, expect, it } from "vite-plus/test";

import {
  extractMetaBehaviorNames,
  extractVocabulary,
  runInterview,
  unobservedInCheck,
  unobservedInTrigger,
  vocabularySets,
  type InterviewDeps,
} from "./generate.js";
import { taxCase } from "./taxFixtures.js";

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

function scriptedDeps(
  proposalJson: string,
  answers: string[],
): { deps: InterviewDeps; output: string[]; asked: string[] } {
  const output: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    output,
    asked,
    deps: {
      complete: () => Promise.resolve(proposalJson),
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(queue.shift() ?? "");
      },
      write: (line) => {
        output.push(line);
      },
    },
  };
}

describe("extractVocabulary", () => {
  it("collects actions, actors, and metadata keys with example values", () => {
    const vocabulary = extractVocabulary(trajectories);
    const actions = vocabulary.map((entry) => entry.action);

    expect(actions).toContain("web_search");
    expect(actions).toContain("open_url_result");

    const openUrlResult = vocabulary.find((entry) => entry.action === "open_url_result")!;
    expect(openUrlResult.actors).toEqual(["tool"]);
    expect(Object.keys(openUrlResult.metadataKeys).sort()).toEqual(["sourceType", "url"]);
  });
});

describe("extractMetaBehaviorNames", () => {
  it("extracts H2 headings", () => {
    expect(extractMetaBehaviorNames(behaviorBody)).toEqual([
      "Read the tax research skill before beginning source research",
      "Consult primary sources before answering",
    ]);
  });

  it("rejects duplicate headings", () => {
    expect(() => extractMetaBehaviorNames("## Same\n\n## Same\n")).toThrow(/duplicate H2/);
  });
});

describe("unobserved vocabulary flagging", () => {
  const sets = vocabularySets(extractVocabulary(trajectories));

  it("flags checks that reference unknown actions", () => {
    expect(
      unobservedInCheck(
        { type: "required", quote: "cites the docs", match: { action: "cite_docs" } },
        sets,
      ),
    ).toEqual(["action `cite_docs`"]);
    expect(
      unobservedInCheck(
        { type: "required", quote: "searches", match: { action: "web_search" } },
        sets,
      ),
    ).toEqual([]);
  });

  it("flags triggers that reference unknown metadata keys", () => {
    expect(
      unobservedInTrigger(
        { description: "Searches.", match: { action: "web_search", metadata: { region: "us" } } },
        sets,
      ),
    ).toEqual(["metadata key `region`"]);
    expect(unobservedInTrigger({ description: "Searches.", semantic: true }, sets)).toEqual([]);
  });

  it("flags pairing, after, and distinctBy references to unknown vocabulary", () => {
    expect(
      unobservedInCheck(
        {
          type: "pairing",
          quote: "handles every tool error",
          each: { action: "tool_error" },
          followedBy: { action: "web_search" },
        },
        sets,
      ),
    ).toEqual(["action `tool_error`"]);
    expect(
      unobservedInCheck(
        {
          type: "required",
          quote: "reports after failing",
          match: { action: "web_search" },
          after: { action: "tool_error" },
        },
        sets,
      ),
    ).toEqual(["action `tool_error`"]);
    expect(
      unobservedInCheck(
        {
          type: "count",
          quote: "consults two distinct venues",
          match: { action: "open_url_result" },
          min: 2,
          distinctBy: "metadata.venue",
        },
        sets,
      ),
    ).toEqual(["metadata key `venue`"]);
  });
});

describe("runInterview", () => {
  it("requires at least one trajectory", async () => {
    const { deps } = scriptedDeps(JSON.stringify(proposal), []);
    await expect(
      runInterview(
        { behaviorName: "primary-source-tax-research", behaviorBody, trajectories: [] },
        deps,
      ),
    ).rejects.toThrow(/at least one sample trajectory/);
  });

  it("emits the proposed IR when every answer accepts", async () => {
    // Accept-all path: trigger + check for meta 1; trigger + check + semantic
    // check for meta 2; final confirm.
    const { deps } = scriptedDeps(JSON.stringify(proposal), ["y", "y", "y", "y", "y", "y"]);

    const ir = await runInterview(
      { behaviorName: "primary-source-tax-research", behaviorBody, trajectories },
      deps,
    );

    expect(ir).toBeDefined();
    expect(ir!.behavior).toBe("primary-source-tax-research");
    expect(ir!.metaBehaviors.map((meta) => meta.name)).toEqual([
      "Read the tax research skill before beginning source research",
      "Consult primary sources before answering",
    ]);
    expect(ir!.metaBehaviors[0]!.checks).toHaveLength(1);
    expect(ir!.metaBehaviors[1]!.semanticChecks).toHaveLength(1);
  });

  it("shows matcher-referenced metadata and clipped content as evidence", async () => {
    const { deps, output } = scriptedDeps(JSON.stringify(proposal), ["y", "y", "y", "y", "y", "y"]);

    await runInterview(
      { behaviorName: "primary-source-tax-research", behaviorBody, trajectories },
      deps,
    );

    // Meta 1 trigger: no metadata in the matcher, short content shown in full.
    expect(output).toContain("  evidence: secondary-then-primary/event-4 (agent web_search)");
    expect(output).toContain(
      '            content: "Example Tax Code home office deduction mixed personal use"',
    );

    // Meta 2 required check: matcher binds metadata.sourceType, long content clipped.
    const index = output.indexOf(
      "  evidence: secondary-then-primary/event-7 (tool open_url_result)",
    );
    expect(index).toBeGreaterThan(-1);
    expect(output[index + 1]).toBe('            metadata.sourceType: "primary"');
    expect(output[index + 2]).toMatch(/^ {12}content: "Example Tax Code section 10: .*…"$/);
  });

  it("flattens whitespace in evidence content", async () => {
    const edited = structuredClone(trajectories[0]!);
    edited.events[3]!.content = "line one\n  line two   with   spaces";
    const { deps, output } = scriptedDeps(JSON.stringify(proposal), ["y", "y", "y", "y", "y", "y"]);

    await runInterview(
      {
        behaviorName: "primary-source-tax-research",
        behaviorBody,
        trajectories: [edited, trajectories[1]!],
      },
      deps,
    );

    expect(output).toContain('            content: "line one line two with spaces"');
  });

  it("labels a no-match forbidden check as expected", async () => {
    const forbiddenProposal = structuredClone(proposal) as unknown as {
      metaBehaviors: Array<{ checks: Array<Record<string, unknown>> }>;
    };
    forbiddenProposal.metaBehaviors[1]!.checks[0] = {
      type: "forbidden",
      quote: "it reads the relevant primary source",
      match: { action: "web_search", contentIncludes: "phrase-no-sample-contains" },
    };

    // Same prompt sequence as the accept-all path.
    const { deps, output } = scriptedDeps(JSON.stringify(forbiddenProposal), [
      "y",
      "y",
      "y",
      "y",
      "y",
      "y",
    ]);

    await runInterview(
      { behaviorName: "primary-source-tax-research", behaviorBody, trajectories },
      deps,
    );

    expect(
      output.some((line) =>
        line.startsWith(
          "  evidence: no sample event matches (expected — well-behaved samples should not exhibit a forbidden event)",
        ),
      ),
    ).toBe(true);
  });

  it("returns undefined when the final confirmation is declined", async () => {
    const { deps } = scriptedDeps(JSON.stringify(proposal), ["y", "y", "y", "y", "y", "n"]);

    const ir = await runInterview(
      { behaviorName: "primary-source-tax-research", behaviorBody, trajectories },
      deps,
    );

    expect(ir).toBeUndefined();
  });

  it("warns about an out-of-vocabulary matcher and keeps it when accepted", async () => {
    const badProposal = structuredClone(proposal) as unknown as {
      metaBehaviors: Array<{ checks: Array<Record<string, unknown>> }>;
    };
    badProposal.metaBehaviors[0]!.checks[0]!.first = { action: "invented_action" };

    // Same prompt sequence as the accept-all path: the flagged check gets a
    // warning line, not an extra prompt.
    const { deps, output } = scriptedDeps(JSON.stringify(badProposal), [
      "y",
      "y",
      "y",
      "y",
      "y",
      "y",
    ]);

    const ir = await runInterview(
      { behaviorName: "primary-source-tax-research", behaviorBody, trajectories },
      deps,
    );

    expect(
      output.some(
        (line) =>
          line.includes("warning:") &&
          line.includes("action `invented_action`") &&
          line.includes("not observed"),
      ),
    ).toBe(true);
    expect(ir!.metaBehaviors[0]!.checks).toHaveLength(1);
    expect(ir!.metaBehaviors[0]!.checks[0]).toMatchObject({
      type: "ordering",
      first: { action: "invented_action" },
    });
  });

  it("demotes an out-of-vocabulary matcher when the user chooses semantic", async () => {
    const badProposal = structuredClone(proposal) as unknown as {
      metaBehaviors: Array<{ checks: Array<Record<string, unknown>> }>;
    };
    badProposal.metaBehaviors[0]!.checks[0]!.first = { action: "invented_action" };

    // meta 1: trigger y, flagged check s (demote), demoted semantic check y;
    // meta 2: trigger y, check y, semantic check y; final confirm.
    const { deps } = scriptedDeps(JSON.stringify(badProposal), ["y", "s", "y", "y", "y", "y", "y"]);

    const ir = await runInterview(
      { behaviorName: "primary-source-tax-research", behaviorBody, trajectories },
      deps,
    );

    expect(ir!.metaBehaviors[0]!.checks).toEqual([]);
    expect(
      ir!.metaBehaviors[0]!.semanticChecks.some(
        (check) => check.quote === "the agent first reads the tax research skill",
      ),
    ).toBe(true);
  });

  it("supports demoting a check and dropping a semantic check mid-interview", async () => {
    // meta 1: trigger y, check s (demote), demoted semantic check d (drop) ->
    // meta 1 dropped for having no checks; meta 2: trigger y, check y,
    // semantic check d, then confirm.
    const { deps, output } = scriptedDeps(JSON.stringify(proposal), [
      "y",
      "s",
      "d",
      "y",
      "y",
      "d",
      "y",
    ]);

    const ir = await runInterview(
      { behaviorName: "primary-source-tax-research", behaviorBody, trajectories },
      deps,
    );

    expect(output.some((line) => line.includes("no checks left"))).toBe(true);
    expect(ir!.metaBehaviors).toHaveLength(1);
    expect(ir!.metaBehaviors[0]!.name).toBe("Consult primary sources before answering");
    expect(ir!.metaBehaviors[0]!.checks).toHaveLength(1);
    expect(ir!.metaBehaviors[0]!.semanticChecks).toEqual([]);
  });

  it("confirms proposed names when the spec has no H2 headings", async () => {
    const bodyWithoutHeadings = "# Primary-source tax research\n\nDo research properly.\n";
    // Name prompts: keep meta 1, rename meta 2; then triggers/checks accepted;
    // final confirm.
    const { deps } = scriptedDeps(JSON.stringify(proposal), [
      "y",
      "e",
      "Renamed meta",
      "y",
      "y",
      "y",
      "y",
      "y",
      "y",
    ]);

    const ir = await runInterview(
      {
        behaviorName: "primary-source-tax-research",
        behaviorBody: bodyWithoutHeadings,
        trajectories,
      },
      deps,
    );

    expect(ir!.metaBehaviors.map((meta) => meta.name)).toEqual([
      "Read the tax research skill before beginning source research",
      "Renamed meta",
    ]);
  });
});
