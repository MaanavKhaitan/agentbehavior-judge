import { describe, expect, it } from "vite-plus/test";

import {
  enforceVocabulary,
  extractMetaBehaviorNames,
  extractVocabulary,
  runInterview,
  type InterviewDeps,
} from "./generate.js";
import type { JudgeIr } from "./ir.js";
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

describe("enforceVocabulary", () => {
  it("demotes matchers that reference unknown actions to semantic checks", () => {
    const ir: JudgeIr = {
      version: 1,
      behavior: "test",
      metaBehaviors: [
        {
          name: "Meta A",
          trigger: { description: "Searches.", match: { action: "web_search" } },
          checks: [
            {
              type: "required",
              quote: "cites the docs",
              match: { action: "cite_docs" },
            },
          ],
          semanticChecks: [],
        },
      ],
    };

    const { ir: enforced, notices } = enforceVocabulary(ir, extractVocabulary(trajectories));

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ metaBehavior: "Meta A", demoted: "required check" });
    expect(enforced.metaBehaviors[0]!.checks).toEqual([]);
    expect(enforced.metaBehaviors[0]!.semanticChecks).toHaveLength(1);
    expect(enforced.metaBehaviors[0]!.semanticChecks[0]!.quote).toBe("cites the docs");
  });

  it("demotes triggers that reference unknown metadata keys to semantic triggers", () => {
    const ir: JudgeIr = {
      version: 1,
      behavior: "test",
      metaBehaviors: [
        {
          name: "Meta A",
          trigger: {
            description: "Searches.",
            match: { action: "web_search", metadata: { region: "us" } },
          },
          checks: [{ type: "required", quote: "searches", match: { action: "web_search" } }],
          semanticChecks: [],
        },
      ],
    };

    const { ir: enforced, notices } = enforceVocabulary(ir, extractVocabulary(trajectories));

    expect(notices[0]).toMatchObject({ demoted: "trigger" });
    expect(enforced.metaBehaviors[0]!.trigger).toEqual({
      description: "Searches.",
      semantic: true,
    });
  });

  it("demotes pairing, after, and distinctBy references to unknown vocabulary", () => {
    const ir: JudgeIr = {
      version: 1,
      behavior: "test",
      metaBehaviors: [
        {
          name: "Meta A",
          trigger: { description: "Searches.", match: { action: "web_search" } },
          checks: [
            {
              type: "pairing",
              quote: "handles every tool error",
              each: { action: "tool_error" },
              followedBy: { action: "web_search" },
            },
            {
              type: "required",
              quote: "reports after failing",
              match: { action: "web_search" },
              after: { action: "tool_error" },
            },
            {
              type: "count",
              quote: "consults two distinct venues",
              match: { action: "open_url_result" },
              min: 2,
              distinctBy: "metadata.venue",
            },
          ],
          semanticChecks: [],
        },
      ],
    };

    const { ir: enforced, notices } = enforceVocabulary(ir, extractVocabulary(trajectories));

    expect(notices.map((notice) => notice.demoted)).toEqual([
      "pairing check",
      "required check",
      "count check",
    ]);
    expect(notices[2]!.problems).toEqual(["metadata key `venue`"]);
    expect(enforced.metaBehaviors[0]!.checks).toEqual([]);
    expect(enforced.metaBehaviors[0]!.semanticChecks).toHaveLength(3);
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

  it("returns undefined when the final confirmation is declined", async () => {
    const { deps } = scriptedDeps(JSON.stringify(proposal), ["y", "y", "y", "y", "y", "n"]);

    const ir = await runInterview(
      { behaviorName: "primary-source-tax-research", behaviorBody, trajectories },
      deps,
    );

    expect(ir).toBeUndefined();
  });

  it("demotes an out-of-vocabulary matcher and tells the user", async () => {
    const badProposal = structuredClone(proposal) as unknown as {
      metaBehaviors: Array<{ checks: Array<Record<string, unknown>> }>;
    };
    badProposal.metaBehaviors[0]!.checks[0]!.first = { action: "invented_action" };

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

    expect(output.some((line) => line.includes("demoted ordering check"))).toBe(true);
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
