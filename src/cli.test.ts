import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { main, type CliDeps } from "./cli.js";
import { parseIr } from "./ir.js";
import type { TrajectoryJudgment } from "./judge.js";
import { taxCase } from "./taxFixtures.js";
import { driveInterview, type InterviewSnapshot } from "./webInterviewTestClient.js";

let temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "behavior-judge-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

const predicateOnlyIr = `version: 1
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
`;

async function writeFixtures(files: Record<string, string>): Promise<string> {
  const directory = await makeTempDir();
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(directory, name), content, { flush: true });
  }
  return directory;
}

async function captureMain(
  argv: string[],
  deps?: CliDeps,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";

  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });

  // Stub loadEnv so the repo's real .env never leaks into process.env: with a
  // real BRAINTRUST_API_KEY loaded, the offline expectations below would make
  // live gateway calls instead.
  const exitCode = await main(argv, { loadEnv: () => Promise.resolve(), ...deps });
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories = [];
});

function semanticResponse(verdict: "true" | "false" | "na", eventId: string): string {
  return JSON.stringify({
    verdict,
    na_reason: null,
    reasoning: "scripted test verdict",
    citations: [{ event_id: eventId, description: "scripted citation" }],
  });
}

describe("behavior-judge judge", () => {
  it("judges trajectories offline with --no-verify and --json", async () => {
    const directory = await writeFixtures({
      "judge.yaml": predicateOnlyIr,
      "trajectories.json": JSON.stringify([
        taxCase("secondary-then-primary").trajectory,
        taxCase("skill-read-too-late").trajectory,
      ]),
    });

    const { exitCode, stdout } = await captureMain([
      "judge",
      path.join(directory, "judge.yaml"),
      path.join(directory, "trajectories.json"),
      "--json",
      "--no-verify",
    ]);

    expect(exitCode).toBe(0);
    const judgments = JSON.parse(stdout) as TrajectoryJudgment[];
    expect(judgments.map((judgment) => [judgment.trajectoryId, judgment.verdict])).toEqual([
      ["secondary-then-primary", "true"],
      ["skill-read-too-late", "false"],
    ]);
    expect(judgments[1]!.metaBehaviors[0]!.clauses[0]).toMatchObject({
      verdict: "false",
      verification: "unverified",
    });
  });

  it("uses an injected completion to verify predicate falses", async () => {
    const directory = await writeFixtures({
      "judge.yaml": predicateOnlyIr,
      "trajectory.json": JSON.stringify(taxCase("skill-read-too-late").trajectory),
    });
    const calls: unknown[] = [];
    const deps: CliDeps = {
      complete: (messages) => {
        calls.push(messages);
        return Promise.resolve(semanticResponse("false", "event-2"));
      },
    };

    const { exitCode, stdout } = await captureMain(
      ["judge", path.join(directory, "judge.yaml"), path.join(directory, "trajectory.json")],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(stdout).toContain("skill-read-too-late: false");
    expect(stdout).toContain("(verifier confirmed)");
    expect(stdout).toContain("[event-2]");
  });

  it("errors when the IR or trajectory arguments are missing", async () => {
    const { exitCode, stderr } = await captureMain(["judge"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("judge requires an IR file");
  });

  it("runs the env loader before dispatching the command", async () => {
    const directory = await writeFixtures({
      "judge.yaml": predicateOnlyIr,
      "trajectory.json": JSON.stringify(taxCase("secondary-then-primary").trajectory),
    });
    let loads = 0;

    const { exitCode } = await captureMain(
      [
        "judge",
        path.join(directory, "judge.yaml"),
        path.join(directory, "trajectory.json"),
        "--no-verify",
      ],
      {
        loadEnv: () => {
          loads += 1;
          return Promise.resolve();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(loads).toBe(1);
  });
});

describe("behavior-judge calibrate", () => {
  it("reports agreement totals and exits 0 when all verdicts match", async () => {
    const cases = [
      {
        trajectory: taxCase("secondary-then-primary").trajectory,
        expected: {
          verdict: "true",
          metaBehaviorVerdicts: {
            "Read the tax research skill before beginning source research": "true",
          },
        },
      },
      {
        trajectory: taxCase("skill-read-too-late").trajectory,
        expected: {
          verdict: "false",
          metaBehaviorVerdicts: {
            "Read the tax research skill before beginning source research": "false",
          },
        },
      },
    ];
    const directory = await writeFixtures({
      "judge.yaml": predicateOnlyIr,
      "cases.json": JSON.stringify(cases),
    });

    const { exitCode, stdout } = await captureMain([
      "calibrate",
      path.join(directory, "judge.yaml"),
      path.join(directory, "cases.json"),
      "--no-verify",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("meta agreement 2/2, file agreement 2/2");
  });

  it("exits 1 and reports the mismatch when a verdict disagrees", async () => {
    const cases = [
      {
        trajectory: taxCase("skill-read-too-late").trajectory,
        expected: {
          verdict: "true",
          metaBehaviorVerdicts: {
            "Read the tax research skill before beginning source research": "true",
          },
        },
      },
    ];
    const directory = await writeFixtures({
      "judge.yaml": predicateOnlyIr,
      "cases.json": JSON.stringify(cases),
    });

    const { exitCode, stdout } = await captureMain([
      "calibrate",
      path.join(directory, "judge.yaml"),
      path.join(directory, "cases.json"),
      "--no-verify",
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISMATCH");
    expect(stdout).toContain("meta agreement 0/1, file agreement 0/1");
  });

  it("errors when a trajectory has no expected verdicts", async () => {
    const directory = await writeFixtures({
      "judge.yaml": predicateOnlyIr,
      "trajectory.json": JSON.stringify(taxCase("skill-read-too-late").trajectory),
    });

    const { exitCode, stderr } = await captureMain([
      "calibrate",
      path.join(directory, "judge.yaml"),
      path.join(directory, "trajectory.json"),
      "--no-verify",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("calibrate requires expected verdicts");
  });
});

const generateProposal = JSON.stringify({
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
          quote: "reads the tax research skill, before searching",
          first: { action: "read_skill" },
          before: [{ action: "web_search" }, { action: "open_url" }],
        },
      ],
      semanticChecks: [],
    },
  ],
});

async function writeGenerateFixture(): Promise<string> {
  const projectDirectory = await makeTempDir();
  const behaviorDirectory = path.join(
    projectDirectory,
    ".agents",
    "behaviors",
    "primary-source-tax-research",
  );
  await mkdir(behaviorDirectory, { recursive: true });
  await writeFile(
    path.join(behaviorDirectory, "BEHAVIOR.md"),
    `---
name: primary-source-tax-research
description: Tax research conduct.
---

# Primary-source tax research

## Read the tax research skill before beginning source research

The agent first reads the tax research skill, before searching or opening a source.
`,
    { flush: true },
  );
  await writeFile(
    path.join(behaviorDirectory, "trajectory.json"),
    JSON.stringify(taxCase("secondary-then-primary").trajectory),
    { flush: true },
  );
  return behaviorDirectory;
}

describe("behavior-judge generate", () => {
  it("runs the interview and writes the confirmed IR", async () => {
    const behaviorDirectory = await writeGenerateFixture();
    const deps: CliDeps = {
      complete: () => Promise.resolve(generateProposal),
      ask: () => Promise.resolve("y"),
    };

    const { exitCode, stdout } = await captureMain(
      ["generate", behaviorDirectory, path.join(behaviorDirectory, "trajectory.json")],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Wrote ");
    const written = await readFile(path.join(behaviorDirectory, "judge.yaml"), "utf8");
    const ir = parseIr(written);
    expect(ir.behavior).toBe("primary-source-tax-research");
    expect(ir.metaBehaviors).toHaveLength(1);
  });

  it("serves the interview on a local browser server with --web", async () => {
    const behaviorDirectory = await writeGenerateFixture();

    // The browser stand-in answers as soon as the CLI "opens" the URL:
    // trigger accept, check accept, confirm save.
    let browserRun: Promise<InterviewSnapshot> | undefined;
    const deps: CliDeps = {
      complete: () => Promise.resolve(generateProposal),
      openBrowser: (url) => {
        browserRun = driveInterview(url, [
          { kind: "accept" },
          { kind: "accept" },
          { kind: "save" },
        ]);
      },
    };

    const { exitCode, stdout } = await captureMain(
      ["generate", behaviorDirectory, path.join(behaviorDirectory, "trajectory.json"), "--web"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Interview running at http://127.0.0.1:");
    expect(stdout).toContain("Wrote ");
    expect((await browserRun!).state.type).toBe("done");
    const written = await readFile(path.join(behaviorDirectory, "judge.yaml"), "utf8");
    expect(parseIr(written).metaBehaviors).toHaveLength(1);
  });

  it("exits 1 without writing when the browser interview is cancelled", async () => {
    const behaviorDirectory = await writeGenerateFixture();

    let browserRun: Promise<InterviewSnapshot> | undefined;
    const deps: CliDeps = {
      complete: () => Promise.resolve(generateProposal),
      openBrowser: (url) => {
        browserRun = driveInterview(url, [
          { kind: "accept" },
          { kind: "accept" },
          { kind: "cancel" },
        ]);
      },
    };

    const { exitCode, stdout } = await captureMain(
      ["generate", behaviorDirectory, path.join(behaviorDirectory, "trajectory.json"), "--web"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Aborted; nothing written.");
    expect((await browserRun!).state).toMatchObject({ type: "done", written: null });
    await expect(readFile(path.join(behaviorDirectory, "judge.yaml"), "utf8")).rejects.toThrow();
  });

  it("errors without a sample trajectory", async () => {
    const { exitCode, stderr } = await captureMain(["generate", "some-behavior"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("at least one sample trajectory JSON");
  });

  it("errors on a spec without frontmatter", async () => {
    const directory = await writeFixtures({
      "BEHAVIOR.md": "# No frontmatter\n\nJust a body.\n",
      "trajectory.json": JSON.stringify(taxCase("secondary-then-primary").trajectory),
    });
    const { exitCode, stderr } = await captureMain([
      "generate",
      directory,
      path.join(directory, "trajectory.json"),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("must start with YAML frontmatter");
    expect(stderr).toContain("is not a valid behavior spec");
  });
});

describe("CLI basics", () => {
  it("prints usage for --help", async () => {
    const { exitCode, stdout } = await captureMain(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("behavior-judge generate");
    expect(stdout).toContain("behavior-judge calibrate");
  });

  it("prints the package version for --version", async () => {
    const { exitCode, stdout } = await captureMain(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("fails on an unknown command", async () => {
    const { exitCode, stderr } = await captureMain(["frobnicate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
  });

  it("fails without a command", async () => {
    const { exitCode, stdout } = await captureMain([]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Usage:");
  });
});
