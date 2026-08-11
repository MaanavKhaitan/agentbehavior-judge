import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

import { behaviorVerdictToScore, foldBehaviorVerdicts, parseIr, serializeIr } from "./ir.js";

const referenceIrUrl = new URL(
  "../examples/primary-source-tax-research/judge.yaml",
  import.meta.url,
);

const minimalIr = `
version: 1
behavior: test-behavior
metaBehaviors:
  - name: Meta A
    trigger:
      description: The agent searches.
      match:
        action: web_search
    checks:
      - type: required
        quote: must search
        match:
          action: web_search
`;

describe("parseIr", () => {
  it("round-trips the checked-in reference IR", async () => {
    const source = await readFile(referenceIrUrl, "utf8");
    const ir = parseIr(source);

    expect(ir.behavior).toBe("primary-source-tax-research");
    expect(ir.metaBehaviors.map((meta) => meta.name)).toEqual([
      "Read the tax research skill before beginning source research",
      "Consult primary sources before answering",
    ]);

    const roundTripped = parseIr(serializeIr(ir));
    expect(roundTripped).toEqual(ir);
  });

  it("parses a minimal IR with defaults", () => {
    const ir = parseIr(minimalIr);
    expect(ir.version).toBe(1);
    expect(ir.metaBehaviors[0]!.semanticChecks).toEqual([]);
    expect(ir.metaBehaviors[0]!.checks[0]).toMatchObject({
      type: "required",
      quote: "must search",
    });
  });

  it("rejects an unknown check type", () => {
    const source = minimalIr.replace("type: required", "type: freshness");
    expect(() => parseIr(source)).toThrow(
      /must be ordering, pairing, required, forbidden, or count/,
    );
  });

  it("parses pairing checks and after/distinctBy fields, and round-trips them", () => {
    const source = `
version: 1
behavior: test-behavior
metaBehaviors:
  - name: Meta A
    trigger:
      description: The agent searches.
      match:
        action: web_search
    checks:
      - type: pairing
        quote: every search result is read
        each:
          action: web_search
        followedBy:
          action: web_search_result
      - type: forbidden
        quote: takes no further actions after answering
        match:
          actor: agent
        after:
          action: final_answer
      - type: count
        quote: consults at least two distinct sources
        match:
          action: open_url_result
        min: 2
        distinctBy: metadata.url
`;
    const ir = parseIr(source);
    expect(ir.metaBehaviors[0]!.checks).toEqual([
      {
        type: "pairing",
        quote: "every search result is read",
        each: { action: "web_search" },
        followedBy: { action: "web_search_result" },
      },
      {
        type: "forbidden",
        quote: "takes no further actions after answering",
        match: { actor: "agent" },
        after: { action: "final_answer" },
      },
      {
        type: "count",
        quote: "consults at least two distinct sources",
        match: { action: "open_url_result" },
        min: 2,
        distinctBy: "metadata.url",
      },
    ]);
    expect(parseIr(serializeIr(ir))).toEqual(ir);
  });

  it("rejects a pairing check without followedBy", () => {
    const source = minimalIr
      .replace("type: required", "type: pairing")
      .replace(/match:\n {10}action: web_search/, "each:\n          action: web_search");
    expect(() => parseIr(source)).toThrow(/checks\[0\]\.followedBy: must be an object/);
  });

  it("rejects a malformed distinctBy", () => {
    const source = `
version: 1
behavior: test-behavior
metaBehaviors:
  - name: Meta A
    trigger:
      description: The agent searches.
      match:
        action: web_search
    checks:
      - type: count
        quote: consults distinct sources
        match:
          action: open_url_result
        min: 2
        distinctBy: url
`;
    expect(() => parseIr(source)).toThrow('must be "content" or "metadata.<key>"');
  });

  it("rejects an empty matcher", () => {
    const source = minimalIr.replace(/match:\n {10}action: web_search/, "match: {}");
    expect(() => parseIr(source)).toThrow(/matcher must set at least one field/);
  });

  it("rejects a check with no quote", () => {
    const source = minimalIr.replace("quote: must search\n        ", "");
    expect(() => parseIr(source)).toThrow(/quote: must be a non-empty string/);
  });

  it("rejects a wrong version", () => {
    expect(() => parseIr(minimalIr.replace("version: 1", "version: 2"))).toThrow(/version/);
  });

  it("rejects a meta-behavior with no checks at all", () => {
    const source = `
version: 1
behavior: test-behavior
metaBehaviors:
  - name: Meta A
    trigger:
      description: The agent searches.
      semantic: true
`;
    expect(() => parseIr(source)).toThrow(/at least one check or semantic check/);
  });

  it("rejects duplicate meta-behavior names", () => {
    const duplicated = parseIr(minimalIr);
    duplicated.metaBehaviors.push(duplicated.metaBehaviors[0]!);
    expect(() => parseIr(serializeIr(duplicated))).toThrow(/duplicate meta-behavior names/);
  });

  it("rejects a trigger with both match and semantic", () => {
    const source = minimalIr.replace(
      "description: The agent searches.",
      "description: The agent searches.\n      semantic: true",
    );
    expect(() => parseIr(source)).toThrow(/cannot set both semantic and match/);
  });

  it("rejects a count check without bounds", () => {
    const source = minimalIr.replace("type: required", "type: count");
    expect(() => parseIr(source)).toThrow(/count check must set min and\/or max/);
  });
});

describe("verdict folding", () => {
  it("folds meta verdicts like the tax judge", () => {
    expect(foldBehaviorVerdicts(["true", "true"])).toBe("true");
    expect(foldBehaviorVerdicts(["true", "false"])).toBe("false");
    expect(foldBehaviorVerdicts(["na", "false"])).toBe("false");
    expect(foldBehaviorVerdicts(["na", "na"])).toBe("na");
    expect(foldBehaviorVerdicts(["true", "na"])).toBe("true");
    expect(() => foldBehaviorVerdicts([])).toThrow(/no meta-behavior verdicts/);
  });

  it("maps verdicts to scores", () => {
    expect(behaviorVerdictToScore("true")).toBe(1);
    expect(behaviorVerdictToScore("false")).toBe(0);
    expect(behaviorVerdictToScore("na")).toBeNull();
  });
});
