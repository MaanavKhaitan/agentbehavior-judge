![behavior-judge logo](docs/assets/logo.png)

[![CI](https://github.com/MaanavKhaitan/behavior-judge/actions/workflows/ci.yml/badge.svg)](https://github.com/MaanavKhaitan/behavior-judge/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

Long-horizon agents are hard to evaluate. [Agent Behavior](https://github.com/braintrustdata/agentbehavior) specs tackle this by observing the process agents take to get to outcomes. `behavior-judge` compiles an Agent Behavior spec into an executable judge for long-horizon agent trajectories, with deterministic checks for most common agent behaviors.

## Why

Real-world tasks are not easily verifiable and an agent can reach the right answer through the wrong process (i.e. a tax agent answering from pretraining instead of verifying
against primary sources still passes an outcome eval). The
[Agent Behavior standard](https://github.com/braintrustdata/agentbehavior), open-sourced
by [Braintrust](https://www.braintrust.dev) and [Basis](https://www.getbasis.ai/)
([launch thread](https://x.com/mitch_troy/status/2082513195357307158)), tackles this
with process supervision: write down how the agent should behave in a natural-language
`BEHAVIOR.md` and ask a model to judge trajectories against it.

![Agent Behavior data flow: a behavior spec and agent trajectories feed an LLM judge, which produces a verdict](docs/assets/llm-judge-simple.svg)

We notice a pattern: most behaviors we expect from long-horizon agents codify into a common set of checks over trajectory events. For example, checking the agent does X before Y, or ensuring the agent never does X.

![Some common agent behavior checks over trajectory events: ordering (X must come before Y), forbidden, and count](docs/assets/behavior-checks.svg)

`behavior-judge` builds on the Agent Behavior project by taking a behavior spec + agent trajectories as input and compiling them into deterministic rules. Judging becomes more consistent from run to run, confining the LLM to the few narrowly scoped checks that need semantic judgement. Every verdict is backed with evidence from the spec and trajectory events.

![behavior-judge data flow: a behavior spec and sample trajectories are compiled via an LLM into a judge YAML intermediate representation, which a deterministic judge program runs over trajectories, calling an LLM only for semantic checks, to produce a verdict](docs/assets/llm-judge-pipeline.svg)

Codifying semantic judges into mechanical checks can help make the loops that evaluate and improve agents more easily verifiable.

## The checks

A compiled judge is a YAML representation of rules, each with two kinds of checks:

- Five deterministic predicates over trajectory events: `ordering` (X before Y),
  `pairing` (every X later followed by Y), `required`, `forbidden`, and `count`
  (min/max, optionally over distinct values). For those interested in runtime verification, this might remind you of property-specification patterns!
- Semantic checks: one narrowly scoped LLM question per clause that no event
  pattern can express ("does the answer rely on the source it read?").

## How it compares to an LLM-only judge

We ran `behavior-judge` head-to-head against a judge that evaluates the whole spec in
one monolithic LLM call, over the two deterministic-only
examples below — 10 runs per judge, same model (`gpt-5-mini`).

| Metric                         | `behavior-judge` | One-call LLM judge |
| ------------------------------ | ---------------- | ------------------ |
| Rule verdicts correct          | 720/720 (100%)   | 682/720 (94.7%)    |
| Perfect runs                   | 20/20            | 3/20               |
| Verdicts unanimous across runs | 72/72            | 58/72              |

`behavior-judge`'s verdicts were byte-identical across all twenty runs. The LLM-only
judge lost points on run-to-run reliability (note: the examples lean toward cases that would trip up an LLM-only judge, like long sessions and incomplete traces):

- applying opposite conventions on different runs of the same input
- calling clauses non-applicable even when the spec explicitly said an empty session satisfies
- failing its own output validation and unable to produce verbatim evidence from the spec

Using a frontier model for the LLM-judge might address these issues, but we still expect to see cost and latency advantages with `behavior-judge`.
Methodology and per-case miss lists live in the example READMEs and
[docs/DETAILS.md](docs/DETAILS.md).

## Running `behavior-judge`

### Install and build

Requires Node ≥ 20 and [pnpm](https://pnpm.io).

```console
$ pnpm install
$ pnpm build              # → dist/; run the CLI as `node dist/cli.mjs`
$ pnpm link --global      # optional: puts `behavior-judge` on your PATH
```

LLM calls go through the
[Braintrust Gateway](https://www.braintrust.dev/docs/guides/proxy): put
`BRAINTRUST_API_KEY` in a `.env` at the repo root (the model defaults to `gpt-5-mini`;
override with `BRAINTRUST_MODEL`).

### Generate a judge from behavior spec

```
behavior-judge generate  <behavior-path> <trajectory.json ...> [--out <file>]
```

Reads your behavior spec + sample trajectories to determine how to compile your desired agent behaviors to deterministic checks. It then drafts a judge and runs an in-browser interview with you to confirm the relevant checks and event vocabulary your trajectories actually use. Writes `judge.yaml` next to the spec.

![The generate web interview reviewing an ordering check](docs/assets/generate-web-interview.png)

### Run the judge on agent trajectories

```
behavior-judge judge  <ir.yaml> <trajectory.json ...> [--json]
```

Runs a judge over trajectories. Deterministic checks are free; the LLM handles semantic clauses + confirming failures of any deterministic checks. The report renders in your browser by default.

![The judge web report showing a failed run with a confirmed forbidden-check violation](docs/assets/judge-web-report.png)

### Update the judge after behavior spec changes

```
behavior-judge generate  --update judge.yaml <behavior-path> <trajectory.json ...>
```

After a spec edit, re-interviews only what changed; unchanged sections carry over.

### Calibrate the judge

```
behavior-judge calibrate <ir.yaml> <trajectory.json ...> [--json]
```

Compare the judge's verdicts against labeled trajectories (`{trajectory, expected}` files) and exits non-zero on any disagreement.

## Examples

Three ready-to-run examples live under [`examples/`](examples/), each with a
`BEHAVIOR.md`, a checked-in `judge.yaml`, and labeled trajectories:

- [`primary-source-tax-research/`](examples/primary-source-tax-research/) — A tax research agent, derived from the Agent Behavior repo.
- [`verified-refund-support/`](examples/verified-refund-support/) — deterministic-only; A
  support agent that must verify identity before account changes, log every refund, and
  never touch a full card number.
- [`staged-rollout-deploys/`](examples/staged-rollout-deploys/) — deterministic-only; An
  SRE agent that must canary before fleet-wide deploys and respect change freezes.

```console
$ behavior-judge judge examples/primary-source-tax-research/judge.yaml \
    examples/primary-source-tax-research/trajectories/skill-read-too-late.json
```

## What a compiled judge looks like

The reference IR for the tax-research example (trimmed):

```yaml
version: 1
behavior: primary-source-tax-research
metaBehaviors:
  - name: Read the tax research skill before beginning source research
    trigger:
      description: The agent begins source research.
      match: # deterministic trigger, any-of
        - action: web_search
        - action: open_url
    checks:
      - type: ordering
        quote: the agent first reads the tax research skill, before searching or opening a source
        first: { action: read_skill }
        before: [{ action: web_search }, { action: open_url }]
  - name: Consult primary sources before answering
    trigger:
      description: The agent answers a tax question.
      semantic: true # no event pattern can detect "tax question" — one scoped LLM call
    checks:
      - type: ordering
        quote: Before deciding on the answer, it reads the relevant primary source
        first: { action: open_url_result, metadata: { sourceType: primary } }
        before: { action: final_answer }
    semanticChecks:
      - quote: bases its conclusion on that source
        question: Does the final answer base its conclusion on the primary source the agent read?
```

Every check carries a verbatim `quote` from the spec, so every verdict traces to the
clause it enforces. Full predicate semantics, the judging pipeline, the browser
frontends, and library usage are documented in [docs/DETAILS.md](docs/DETAILS.md).

## License

Apache-2.0 (see [LICENSE](LICENSE)), same as the upstream Agent Behavior repo. The
example spec, the tax fixture data, and the gateway client derive from that repo's
examples.
