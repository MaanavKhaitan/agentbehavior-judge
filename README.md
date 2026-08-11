# agentbehavior-judge

Compile an [Agent Behavior](https://github.com/braintrustdata/agentbehavior) spec into a
checked-in judge and run it over agent trajectories.

`BEHAVIOR.md` specs deliberately stay implementation-free, so every adopter ends up
hand-building judging machinery. `behavior-judge` closes that gap:

- **`generate`** interviews you through compiling a spec into a YAML intermediate
  representation (`judge.yaml`): deterministic predicate checks bound to the event
  vocabulary actually observed in your sample trajectories, plus narrowly scoped
  per-clause LLM checks for the judgment calls.
- **`judge`** executes an IR over trajectory JSON files. Predicates are free; LLM calls
  are reserved for semantic clauses and for confirming predicate violations.
- **`calibrate`** measures judge agreement against trajectories with known verdicts.

```
behavior-judge generate  <behavior-path> <trajectory.json ...> [--out <file>] [--model <m>]
behavior-judge judge     <ir.yaml> <trajectory.json ...> [--json] [--model <m>] [--no-verify]
behavior-judge calibrate <ir.yaml> <trajectory.json ...> [--json] [--model <m>] [--no-verify]
```

LLM calls go through the [Braintrust Gateway](https://www.braintrust.dev/docs/guides/proxy)
(`BRAINTRUST_API_KEY`, `BRAINTRUST_MODEL`, `BRAINTRUST_GATEWAY_BASE_URL`). Without an API
key everything still runs: semantic checks report `na` and predicate failures stay
`unverified`.

## Trajectory JSON

A trajectory is `{id, description?, complete, events}` where each event is
`{id, actor: "user"|"agent"|"tool", action, content, metadata?}`. A file may contain a bare
trajectory, a `{trajectory, expected}` wrapper (`expected` holds the known verdicts that
`calibrate` compares against), or an array of either.

## The IR

The checked-in reference IR for the
[`primary-source-tax-research`](../../examples/.agents/behaviors/primary-source-tax-research/BEHAVIOR.md)
example spec:

```yaml
version: 1
behavior: primary-source-tax-research
metaBehaviors:
  - name: Read the tax research skill before beginning source research
    trigger:
      description: The agent begins source research.
      match: # any-of; the meta-behavior is NA unless one matches
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
    semanticChecks: []
  - name: Consult primary sources before answering
    trigger:
      description: The agent answers a tax question.
      semantic: true # no event pattern can detect "tax question"; one scoped LLM call
    checks:
      - type: ordering
        quote: Before deciding on the answer, it reads the relevant primary source
        first:
          action: open_url_result
          metadata:
            sourceType: primary
        before:
          action: final_answer
    semanticChecks:
      - quote: bases its conclusion on that source
        question: Does the final answer base its conclusion on the primary source the agent read?
```

Every check carries a verbatim `quote` from the spec, so each verdict traces back to the
clause it enforces. An event matcher (`action` / `actor` / `contentIncludes` / `metadata`)
only ever references vocabulary observed in the sample trajectories you gave `generate`;
clauses that would need vocabulary your traces don't record become semantic checks instead.

Predicate semantics (evaluated after the trigger fires):

| type        | true                                              | false                                               | na                                              |
| ----------- | ------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `ordering`  | first `first`-match precedes first `before`-match | a `before`-match with no prior `first`-match        | no `before`-match                               |
| `pairing`   | every `each`-match has a later `followedBy`-match | an `each`-match with no later match, trace complete | no `each`-match; unmatched but trace incomplete |
| `required`  | match exists                                      | no match and trace complete                         | no match, trace incomplete                      |
| `forbidden` | no match                                          | match exists                                        | never (see `after`)                             |
| `count`     | within `min`/`max`                                | over `max`; under `min` when complete               | under `min`, trace incomplete                   |

`required`, `forbidden`, and `count` accept an optional `after:` matcher that scopes the
check to events strictly after the first `after`-match ("once X happens…" clauses, e.g.
"after emitting the final answer, the agent takes no further actions"); when the window
never opens the check is `na`. `count` also accepts `distinctBy: "content"` or
`distinctBy: "metadata.<key>"` to count distinct values instead of raw matches ("consults
at least two distinct sources"); matches missing the key are not counted.

## How judging runs

Per meta-behavior: the trigger gates everything (a predicate trigger with no match is `na`
with zero LLM calls); deterministic checks run for free; each predicate `false` gets one
scoped verify call (matchers are exact about events but approximate about clause meaning —
e.g. an unrelated `web_search` can trip an ordering check — and a single `false` gates the
file verdict). A confirmed `false` short-circuits the remaining semantic checks; otherwise
each semantic check runs as its own narrow LLM call. Verdicts fold deterministically:
any `false` → `false`; all `na` → `na`; else `true`.

## Walkthrough (tax fixtures)

From the repo root, with the fixture trajectory exported to JSON (the test suite's
`skill-read-too-late` case, where the agent opens a source before reading the skill):

```console
$ behavior-judge judge \
    examples/.agents/behaviors/primary-source-tax-research/judge.yaml \
    skill-read-too-late.json --no-verify
skill-read-too-late: false
  Read the tax research skill before beginning source research: false
    predicate "the agent first reads the tax research skill, before searching or opening a source": false [event-2] (unverified)
  Consult primary sources before answering: na(insufficient_evidence)
    semantic "The agent answers a tax question.": na(insufficient_evidence)
```

The first meta-behavior fails deterministically — event-2 is a source open with no prior
skill read — with no LLM in the loop. With `BRAINTRUST_API_KEY` set, drop `--no-verify`:
the verifier confirms the violation, the semantic trigger for the second meta-behavior
fires, and its clauses get judged too.

To measure the IR against trajectories with known verdicts:

```console
$ behavior-judge calibrate judge.yaml cases.json
secondary-then-primary: file expected true, got true — ok
  Read the tax research skill before beginning source research: expected true, got true — ok
...

meta agreement 12/12, file agreement 6/6
```

`calibrate` exits 1 on any disagreement, so it can gate CI.

## Generating an IR for your own spec

```console
$ behavior-judge generate .agents/behaviors/my-behavior sample-trajectories.json
```

`generate` requires at least one sample trajectory: predicates are only proposed for
actions and metadata keys your traces actually record (never for vocabulary that would
require re-instrumentation). One LLM call drafts the IR; anything out-of-vocabulary is
demoted to a semantic check in code, never trusted from the model. You then review each
piece — accept, demote to semantic, drop, or edit — with matching sample events shown as
evidence, and the confirmed YAML is written next to your `BEHAVIOR.md` (or to `--out`).

Hand-writing `judge.yaml` is equally supported; `generate` is a convenience, not a
requirement.

## Library use

```ts
import { judgeTrajectory, parseIr, loadTrajectoryFile } from "agentbehavior-judge";

const ir = parseIr(await fs.readFile("judge.yaml", "utf8"));
const [trajectoryCase] = await loadTrajectoryFile("trajectory.json");
const judgment = await judgeTrajectory({ ir, trajectory: trajectoryCase.trajectory });
```

`judgeTrajectory` accepts a `complete` injection seam (`(messages) => Promise<string>`) so
tests and evals can run without a network.
