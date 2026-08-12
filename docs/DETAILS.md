# agentbehavior-judge: the detailed guide

This is the long-form documentation — full predicate semantics, the judging pipeline,
calibration methodology, and the `--web` frontends. For the concise overview, start with
the [README](../README.md).

Compile an [Agent Behavior](https://github.com/braintrustdata/agentbehavior) spec into a
checked-in judge and run it over agent trajectories.

`BEHAVIOR.md` specs deliberately stay implementation-free, so every adopter ends up
hand-building judging machinery. `behavior-judge` closes that gap:

- **`generate`** interviews you through compiling a spec into a YAML intermediate
  representation (`judge.yaml`): deterministic predicate checks bound to your agent's
  event vocabulary — verified against sample trajectories, or confirmed by you when the
  samples don't exhibit it — plus narrowly scoped per-clause LLM checks for the
  judgment calls.
- **`judge`** executes an IR over trajectory JSON files. Predicates are free; LLM calls
  are reserved for semantic clauses and for confirming predicate violations.
- **`calibrate`** measures judge agreement against trajectories with known verdicts.

```
behavior-judge generate  <behavior-path> <trajectory.json ...> [--update <ir.yaml>] [--out <file>] [--model <m>] [--web]
behavior-judge judge     <ir.yaml> <trajectory.json ...> [--json] [--model <m>] [--no-verify] [--web]
behavior-judge calibrate <ir.yaml> <trajectory.json ...> [--json] [--model <m>] [--no-verify]
```

LLM calls go through the [Braintrust Gateway](https://www.braintrust.dev/docs/guides/proxy)
(`BRAINTRUST_API_KEY`, `BRAINTRUST_MODEL`, `BRAINTRUST_GATEWAY_BASE_URL`). Variables not
already set in the environment are read from the nearest `.env` file at or above the
working directory, so a gitignored `.env` at the repo root is enough. Without an API
key everything still runs: semantic checks report `na` and predicate failures stay
`unverified`.

## Trajectory JSON

A trajectory is `{id, description?, complete, events}` where each event is
`{id, actor: "user"|"agent"|"tool", action, content, metadata?}`. A file may contain a bare
trajectory, a `{trajectory, expected}` wrapper (`expected` holds the known verdicts that
`calibrate` compares against), or an array of either.

## The IR

The checked-in reference IR for the
[`primary-source-tax-research`](../examples/primary-source-tax-research/BEHAVIOR.md)
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
references vocabulary that is either observed in the sample trajectories you gave
`generate` or explicitly confirmed by you during its interview; clauses that fit neither
become semantic checks instead.

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

[`examples/primary-source-tax-research/`](../examples/primary-source-tax-research/) carries
the example spec, its reference IR, and the six tax-research fixture trajectories as
per-case `{trajectory, expected}` JSON files under `trajectories/`. From the repo root
(`skill-read-too-late` is the case where the agent opens a source before reading the
skill):

```console
$ behavior-judge judge \
    examples/primary-source-tax-research/judge.yaml \
    examples/primary-source-tax-research/trajectories/skill-read-too-late.json --no-verify
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

With `--web` the same report renders in your browser: the CLI starts a local-only
server (127.0.0.1, one-time token in the URL), opens the page, and shows one card per
run — cards appear live as runs are judged — with plain-language verdicts, each rule
expandable down to its clauses, and the deciding events quoted as evidence. The page
tells the terminal once it has rendered, the server shuts down, and the plain-text
report above still prints. `--web` combines with everything except `--json` (pick one
format) and is not available for `calibrate` yet.

To measure the IR against trajectories with known verdicts (with `BRAINTRUST_API_KEY`
set — the semantic clauses need the LLM to reach the expected verdicts):

```console
$ behavior-judge calibrate \
    examples/primary-source-tax-research/judge.yaml \
    examples/primary-source-tax-research/trajectories/*.json
secondary-then-primary: file expected true, got true — ok
  Read the tax research skill before beginning source research: expected true, got true — ok
...

meta agreement 12/12, file agreement 6/6
```

`calibrate` exits 1 on any disagreement, so it can gate CI.

## More examples: predicate-only judges

Two further examples cover the remaining predicate types and need no LLM at all to reach
their expected verdicts (their triggers and checks are all deterministic;
`src/core/examples.test.ts` re-derives every checked-in verdict offline in CI):

- [`examples/verified-refund-support/`](../examples/verified-refund-support/) — a
  customer-support refund agent: `ordering` (passed identity verification before any
  account change), `pairing` (every refund followed by a case note), `forbidden` (never
  fetch a full card number), and `count` with `max` (at most two refund _attempts_).
- [`examples/staged-rollout-deploys/`](../examples/staged-rollout-deploys/) — an SRE deploy
  agent: `ordering` on event metadata (canary stage before fleet stage), `pairing`
  (health-check every deploy), `forbidden` scoped by `after:` to a change-freeze window
  opened by a `contentIncludes` match, and `count` with `min` + `distinctBy` (healthy
  canary results from three _distinct_ hosts).

Their fixtures are built around the places where holistic LLM judges drift: a forbidden
event buried in a 41-event session, six healthy checks that only touch two distinct
hosts, retries that make three attempts look like two refunds, "I logged it" claims with
no logging event, and incomplete traces where absence is `insufficient_evidence` rather
than a violation. The suites are deliberately violation-heavy, and each example README
carries fairness notes: one case per example hinges on a disclosed incomplete-trace
convention and is tallied separately in the stats below.

## Comparing against a one-call LLM judge

The upstream Agent Behavior repo ships an example judge that evaluates the whole spec in
one monolithic LLM call. [`scripts/upstream-calibrate.mjs`](../scripts/upstream-calibrate.mjs)
ports that judge verbatim and runs it over the same labeled trajectory files, and
[`scripts/agreement-stats.mjs`](../scripts/agreement-stats.mjs) aggregates repeated runs
from either judge:

```console
$ node scripts/upstream-calibrate.mjs examples/verified-refund-support/BEHAVIOR.md \
    examples/verified-refund-support/trajectories/*.json --runs 5 --json > runs.json
$ node scripts/agreement-stats.mjs --convention-cases cutoff-before-log runs.json
```

Measured 2026-08-11, default model (`gpt-5-mini`) for both judges: 10 repeated runs per
judge per example over all 9 labeled cases (36 meta verdicts per run, 720 per judge in
total):

| Metric                               | `behavior-judge` | Upstream one-call judge         |
| ------------------------------------ | ---------------- | ------------------------------- |
| Pooled meta-verdict accuracy         | 720/720 (100%)   | 682/720 (94.7%)                 |
| Mean per-run agreement, refund suite | 100.0% ± 0.0%    | 91.4% ± 4.8% (worst run: 77.8%) |
| Mean per-run agreement, deploy suite | 100.0% ± 0.0%    | 98.1% ± 1.0%                    |
| Perfect runs                         | 20/20            | 3/20                            |
| Verdict slots unanimous across runs  | 72/72            | 58/72                           |

Our judge's runs were live (verify-on-false enabled) and byte-identical across all
twenty; the same verdicts are reproduced offline with zero LLM calls in CI. The
one-call judge's losses came from three places: the two disclosed incomplete-trace
convention cases (where it applied _opposite_ conventions on different runs of the same
input), a vacuous-bound clause it kept calling `not_applicable` even after the spec
said outright that an empty session satisfies it, and one run where two whole cases
died on its verbatim-quote output validation. On complete traces with valid output it
judged the trap cases well — the measured gap is reliability, not domain reasoning.
Per-example READMEs carry the detailed tables, miss lists, and fairness notes.

## Generating an IR for your own spec

```console
$ behavior-judge generate .agents/behaviors/my-behavior sample-trajectories.json
```

`generate` requires at least one sample trajectory: it extracts the event vocabulary your
traces actually record, and one LLM call drafts the IR against it. You then review each
piece — accept, demote to semantic, drop, or edit — with matching sample events shown as
evidence. A matcher that references vocabulary your samples never exhibit gets a printed
warning instead of silent trust (common for forbidden or rare behaviors that clean traces
never show); accepting it is your assertion that the instrumentation emits that event —
if it doesn't, demote the clause to a semantic check or drop it. The confirmed YAML is
written next to your `BEHAVIOR.md` (or to `--out`).

With `--web` the same interview runs in your browser instead of the terminal: the CLI
starts a local-only server (bound to 127.0.0.1, guarded by a one-time token in the URL),
opens the page, and walks you through one card per trigger/check with the matchers
rendered in plain language, sample events shown as evidence, and a back button for
revisiting earlier answers. The terminal process still does everything real — the LLM
call, the vocabulary flagging, writing `judge.yaml` — so nothing about the output
changes; close the tab or Ctrl-C the terminal to abort.

Hand-writing `judge.yaml` is equally supported; `generate` is a convenience, not a
requirement.

`generate` reads the spec's frontmatter (`name`, `description`) and markdown body
directly. To lint a spec against the full Agent Behavior standard, use the
[`agentbehavior` validator CLI](https://github.com/braintrustdata/agentbehavior).

### Updating an IR after a spec edit

```console
$ behavior-judge generate .agents/behaviors/my-behavior sample-trajectories.json --update judge.yaml
```

Once a `judge.yaml` exists, editing the spec doesn't mean redoing the whole interview.
Each generated meta-behavior records the spec section it was reviewed against (the
`source` field), so `--update` diffs the current spec against the existing IR and
re-interviews only the difference: unchanged sections carry over with zero questions and
zero LLM calls, removed sections drop with a notice, and new sections are interviewed
like plain `generate`.

Within an edited section, clauses whose quoted spec sentences survive verbatim are
carried from the existing file — your earlier answers and hand edits win over any fresh
model output — and collapse into a single batch confirmation, while edited or new
sentences get individual questions. Because an edit can also shift the meaning of a
sentence it didn't touch (say, redefining a term a matcher relies on), one scoped LLM
call reviews the carried clauses against the before/after section texts and can flag
them for individual re-asking, with its reason printed. That call is demote-only: it can
make the review more careful, never less — and answering `n` at the batch confirmation
always gets you the full clause-by-clause walkthrough. The updated YAML is written back
to the `--update` path (or to `--out`). `--update` combines with `--web`: the same
diff-scoped interview runs in your browser, with carried clauses as a single
keep-all card and flagged ones called out with the triage reason. Running `calibrate`
afterwards is the safety net for anything both the quote diff and the triage missed.

## Library use

```ts
import { judgeTrajectory, parseIr, loadTrajectoryFile } from "agentbehavior-judge";

const ir = parseIr(await fs.readFile("judge.yaml", "utf8"));
const [trajectoryCase] = await loadTrajectoryFile("trajectory.json");
const judgment = await judgeTrajectory({ ir, trajectory: trajectoryCase.trajectory });
```

`judgeTrajectory` accepts a `complete` injection seam (`(messages) => Promise<string>`) so
tests and evals can run without a network.

## Development

Requires Node >= 20 and [pnpm](https://pnpm.io).

```console
$ pnpm install
$ pnpm build   # vp pack → dist/
$ pnpm test    # vp test --run
$ pnpm check   # vp check (fmt + lint)
```

After a build the CLI runs as `node dist/cli.mjs`, or `pnpm link --global` puts
`behavior-judge` on your PATH.

## Credits and license

This project is built on the
[Agent Behavior standard](https://github.com/braintrustdata/agentbehavior) by
[Braintrust](https://github.com/braintrustdata) — the `BEHAVIOR.md` spec format, the
validator, and the original examples all live there. The example spec, the tax-research
fixture data, and the Braintrust Gateway client in this repo derive from that project's
examples.

Apache-2.0 (see [LICENSE](../LICENSE)), same as the upstream Agent Behavior repo.
