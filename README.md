# behavior-judge

Compile an [Agent Behavior](https://github.com/braintrustdata/agentbehavior) spec into an
executable, checked-in judge for long-horizon agent trajectories — deterministic where
LLM judges drift, auditable down to the spec clause, with the model reserved for the few
judgments only it can make.

## Why

Long-horizon agents are hard to evaluate. Real-world tasks run for hours or days,
ground truth is scarce, and an agent can reach the right answer through a process
nobody should trust — a tax agent answering from pretraining instead of verifying
against primary sources still passes an outcome eval. The
[Agent Behavior standard](https://github.com/braintrustdata/agentbehavior), open-sourced
by [Braintrust](https://www.braintrust.dev) together with Basis
([launch thread](https://x.com/mitch_troy/status/2082513195357307158)), tackles this
with process supervision: write down how the agent should behave in a freeform
`BEHAVIOR.md` and judge trajectories against it — no ground truth required, so every
trajectory yields signal.

Behavior specs deliberately say nothing about _how_ to judge, and the default is to
hand the spec and the whole trajectory to one big LLM call. But read through enough
specs and a pattern emerges: most behaviors we expect from long-horizon agents —
verify identity before changing the account, read the skill before researching, never
touch a full card number — codify into a small common set of checks over trajectory
events. `behavior-judge` builds on the Agent Behavior project by compiling a spec into
exactly that: a YAML judge you check in and review like code. Judging stays declarative
— the judge states what must hold, not how to scan for it — but becomes deterministic
and consistent from run to run, with the LLM confined to the few narrowly scoped calls
that genuinely need semantic judgment. Every verdict traces back to a verbatim quote
from the spec plus the IDs of the events that decided it.

Zooming out, this is one instance of a pattern we expect to matter broadly: codifying
semantic judges into deterministic, auditable checks, so the loops that evaluate and
improve agents run on signal you can actually verify.

## The checks

A compiled judge is a list of rules, each with a **trigger** ("does this rule apply
here at all?" — an untriggered rule is `n/a`, never a failure) and two kinds of checks:

- **Five deterministic predicates** over trajectory events: `ordering` (X before Y),
  `pairing` (every X later followed by Y), `required`, `forbidden`, and `count`
  (min/max, optionally over distinct values), plus an `after:` scope for "once X
  happens…" clauses. If you know runtime verification, you've met these before —
  they're the classic property-specification patterns (precedence, response, existence,
  absence, bounded existence) wearing YAML.
- **Semantic checks**: one narrowly scoped LLM question per clause that no event
  pattern can express ("does the answer rely on the source it read?"), each answer
  validated to cite real events.

Verdicts are three-valued: a violation visible in the trace is `false` even if the
trace is incomplete, but absence in an unfinished trace is `insufficient_evidence` —
never a failure.

## Install & build

Requires Node ≥ 20 and [pnpm](https://pnpm.io).

```console
$ pnpm install
$ pnpm build              # → dist/; run the CLI as `node dist/cli.mjs`
$ pnpm link --global      # optional: puts `behavior-judge` on your PATH
```

LLM calls go through the
[Braintrust Gateway](https://www.braintrust.dev/docs/guides/proxy): put
`BRAINTRUST_API_KEY` in a `.env` at the repo root (the model defaults to `gpt-5-mini`;
override with `BRAINTRUST_MODEL`). Without a key everything still runs offline:
predicates evaluate, semantic clauses report `na`.

## Use

```
behavior-judge generate  <behavior-path> <trajectory.json ...> [--update <ir.yaml>] [--out <file>] [--no-web]
behavior-judge judge     <ir.yaml> <trajectory.json ...> [--json] [--no-verify] [--no-web]
behavior-judge calibrate <ir.yaml> <trajectory.json ...> [--json]
```

Trajectories are JSON — `{id, complete, events: [{id, actor, action, content,
metadata?}, ...]}` (an instrumentation convention of this tool, not part of the
standard).

- **`generate`** — one LLM call drafts a judge bound to the event vocabulary your
  sample trajectories actually use, then an interview (in your browser by default, or
  the terminal with `--no-web`) walks you through every trigger and check with matching
  events shown as evidence: accept, edit, demote to a semantic check, or drop. Writes
  `judge.yaml` next to the spec. Hand-writing the YAML is equally supported.
- **`judge`** — runs a judge over trajectories. Predicates are free; the LLM handles
  semantic clauses plus one confirmation call per predicate failure (a matcher can trip
  on an event the clause didn't mean). The report renders in your browser by default;
  `--no-web` or `--json` keeps it in the terminal.
- **`generate --update judge.yaml`** — after a spec edit, re-interviews only what
  changed; unchanged sections carry over with zero questions and zero LLM calls.
- **`calibrate`** — compares verdicts against labeled trajectories
  (`{trajectory, expected}` files) and exits non-zero on any disagreement, so it can
  gate CI.

## Examples

Three ready-to-run examples live under [`examples/`](examples/), each with a
`BEHAVIOR.md`, a checked-in `judge.yaml`, and labeled trajectories:

- [`primary-source-tax-research/`](examples/primary-source-tax-research/) — the
  semantic showcase (LLM trigger + semantic check), derived from the upstream repo's
  example.
- [`verified-refund-support/`](examples/verified-refund-support/) — predicate-only: a
  support agent that must verify identity before account changes, log every refund, and
  never touch a full card number.
- [`staged-rollout-deploys/`](examples/staged-rollout-deploys/) — predicate-only: an
  SRE agent that must canary before fleet-wide deploys and respect change freezes.

```console
$ behavior-judge judge examples/primary-source-tax-research/judge.yaml \
    examples/primary-source-tax-research/trajectories/skill-read-too-late.json
```

On the two predicate-only suites, this judge matched all 720 labeled meta-verdicts
across repeated runs (byte-identical each time); the upstream one-call LLM judge scored
682/720. Methodology and per-case breakdowns are in
[docs/DETAILS.md](docs/DETAILS.md).

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
