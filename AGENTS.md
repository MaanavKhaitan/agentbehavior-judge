# Agent context for this repo

Orientation for coding agents (and humans) working on `agentbehavior-judge`. Verify
details against the code if much has changed since 2026-08.

## 1. The repo in one paragraph

`agentbehavior-judge` is a companion tool to the
[Agent Behavior standard](https://github.com/braintrustdata/agentbehavior): specs
(`BEHAVIOR.md`) describe expected agent conduct in prose and deliberately say nothing
about how to judge a trajectory against them. This package closes that gap — it compiles
a spec into a **checked-in YAML judge IR** where deterministic event-pattern predicates
do most of the judging for free, and the LLM is confined to three narrow,
individually-validated jobs: semantic triggers, semantic checks, and one confirmation
call per predicate `false`. Every verdict traces to a verbatim spec `quote` plus
event-ID citations. The package was extracted (history-preserving) from a fork of the
standard's monorepo; it is Apache-2.0, and the example spec, tax fixture data, and
gateway client derive from that repo's examples.

## 2. Tooling and conventions

- **pnpm** (`pnpm@10.33.0` via `packageManager`) + **vite-plus (`vp`)**: `pnpm build`
  (`vp pack`: build, dts, esm), `pnpm test` (`vp test --run`, vitest-compatible; import
  from `"vite-plus/test"`), `pnpm check` (`vp check [--fix]`, fmt + lint). Run
  `pnpm exec vp check --fix` before committing.
- TypeScript: `NodeNext` + `.js` import extensions, `strict`,
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. Type `module`.
- CLI pattern (`src/cli.ts`): `main(argv, deps?): Promise<number>`,
  `process.stdout.write`, `pathToFileURL` entry guard, `node:util parseArgs`, injectable
  deps for tests, `captureMain` stdout/stderr spy pattern in tests.
- **Gotchas:**
  - `pnpm-workspace.yaml` exists only to mark this directory as its own pnpm root —
    without it, a checkout nested under another pnpm workspace installs to the wrong
    root. Don't delete it.
  - `pnpm exec tsc --noEmit` emits a TS6059 rootDir complaint about `vite.config.ts` —
    long-standing quirk inherited from the monorepo; harmless (`vp` builds fine).
  - The repo lives under the `MaanavKhaitan` GitHub account; if `gh` has multiple
    accounts logged in, `gh auth switch -u MaanavKhaitan` before pushing (and switch
    back after).

## 3. CLI surface

```
behavior-judge generate  <behavior-path> <trajectory.json ...> [--out <file>] [--model <m>]
behavior-judge judge     <ir.yaml> <trajectory.json ...> [--json] [--model <m>] [--no-verify]
behavior-judge calibrate <ir.yaml> <trajectory.json ...> [--json] [--model <m>] [--no-verify]
```

Exit codes: `judge` 0 on successful run; `calibrate` 1 on any expected/actual
disagreement (CI gate); `generate` 1 if the user declines the final confirm. Errors → 1.

## 4. Source map (`src/`, dependency order)

- `trajectory.ts` — `TrajectoryEvent`/`AgentTrajectory`/`ExpectedBehaviorJudgment`/
  `TrajectoryCase` + `loadTrajectoryFile` (accepts bare trajectory, `{trajectory,
expected}` wrapper, or array of either; rejects duplicate event IDs).
- `spec.ts` — `loadBehaviorSpec`: minimal BEHAVIOR.md loader (file or directory path,
  frontmatter `name`/`description`, markdown body). Deliberately NOT a full validator —
  lint specs against the standard with the upstream `agentbehavior` CLI.
- `ir.ts` — IR types + strict `parseIr` (fail-fast, path-labeled errors like
  `metaBehaviors[0].checks[1].quote`), `serializeIr`, `foldBehaviorVerdicts`,
  `behaviorVerdictToScore`.
- `predicates.ts` — pure deterministic core: `matchesEvent`/`matchesAny`/`findMatches` +
  `evaluatePredicate`. No LLM, no IO.
- `gateway.ts` — Braintrust Gateway client + JSON helpers + `completeJsonWithRetry`
  (retry-once-with-error-appended) + `JudgeCompletion` type.
- `semantic.ts` — the scoped LLM check: one system prompt, `parseSemanticResult`
  (verdict enum; `na_reason` iff `na`; ≥1 citation whose event IDs must exist), and two
  message builders sharing that parser: `buildSemanticCheckMessages` and
  `buildVerifyFalseMessages`.
- `judge.ts` — orchestrator `judgeTrajectory` (all judging policy lives here),
  `resolveCompletion` (offline detection), result types, `compareToExpected`.
- `generate.ts` — H2 extraction, `extractVocabulary`, proposal prompt + `parseProposal`,
  unobserved-vocabulary flagging (`vocabularySets`/`unobservedInTrigger`/
  `unobservedInCheck`), `runInterview` (seams: `complete`/`ask`/`write`).
- `env.ts` — nearest-`.env` discovery (`loadNearestDotEnv`/`applyNearestDotEnv`): the CLI
  fills `process.env` from the closest `.env` at or above cwd; already-set variables win.
  CLI-only concern, not exported from `index.ts`; `cli.test.ts`'s `captureMain` stubs the
  `CliDeps.loadEnv` seam so the repo's real `.env` never leaks into tests.
- `cli.ts` — dispatch, report formatting, readline wiring, `CliDeps` injection.
- `index.ts` — public exports. `taxFixtures.ts` — test-only copy of the six tax cases
  (not packed/exported).

## 5. Event schema (tool convention, NOT part of the standard)

```ts
TrajectoryEvent = { id, actor: "user"|"agent"|"tool", action: string, content, metadata?: Record<string,string> }
AgentTrajectory = { id, description?, complete: boolean, events }
```

`actor` is a closed enum; `action` is an **open string** invented by whoever instruments
the agent (hence the vocabulary-binding rule below). The tax vocabulary uses a
request/result convention: agent emits `web_search`/`open_url`/`read_skill`/
`final_answer`; tool emits `*_result` (results carry `metadata.sourceType:
"primary"|"secondary"` — which is why "read a primary source" matches on
`open_url_result`, not `open_url`). `complete` drives every na-vs-false decision.

## 6. IR schema (YAML, camelCase, `version: 1`)

```yaml
version: 1
behavior: <spec name>
metaBehaviors:
  - name: <exact H2 heading, or confirmed synthetic name>
    trigger: { description, match: <pattern> } # or { description, semantic: true }
    checks: # PredicateCheck[]
      - { type: ordering, quote, first: <pattern>, before: <pattern> }
      - { type: pairing, quote, each: <pattern>, followedBy: <pattern> }
      - { type: required, quote, match: <pattern>, after?: <pattern> }
      - { type: forbidden, quote, match: <pattern>, after?: <pattern> }
      - { type: count, quote, match: <pattern>, min?, max?, after?: <pattern>, distinctBy? } # needs min and/or max; distinctBy is "content" or "metadata.<key>"
    semanticChecks:
      - { quote, question }
```

- **Naming:** `EventMatcher` = one pattern, AND across its fields (`action`/`actor`/
  `contentIncludes`/`metadata`). `EventPattern` (TS type) = one matcher or an array
  meaning **any-of** (OR). YAML keys stay `match:`/`first:`/`before:`/`each:`/`followedBy:`/`after:`.
- Every check carries a verbatim `quote` from the spec (traceability requirement).
- `after:` (required/forbidden/count only) scopes the check to events strictly after the
  first `after`-match; no `after`-match → `na` by completeness. `distinctBy` (count only)
  counts distinct `content` or `metadata.<key>` values; matches missing the key don't count.
- `parseIr` rejects: unknown check type, empty matcher, missing quote, duplicate meta
  names, trigger with both `match` and `semantic`, count without bounds, malformed
  `distinctBy`, meta with zero checks of either kind.

## 7. Predicate semantics (post-trigger)

| type        | true                                                                               | false                                                                                        | na                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ordering`  | first `first`-match precedes first `before`-match                                  | a `before`-match with no prior `first`-match (violation observed → false even if incomplete) | no `before`-match: complete → `not_applicable`; incomplete → `insufficient_evidence`                                          |
| `pairing`   | every `each`-match has a later `followedBy`-match (one follower may serve several) | an `each`-match with no later follower, and complete (cites the unmatched events)            | no `each`-match: `not_applicable`/`insufficient_evidence` by completeness; unmatched but incomplete → `insufficient_evidence` |
| `required`  | match exists                                                                       | no match and complete                                                                        | no match, incomplete → `insufficient_evidence`                                                                                |
| `forbidden` | no match                                                                           | match exists (cites all matches)                                                             | only when an `after:` window never opens                                                                                      |
| `count`     | within min/max                                                                     | over max (even incomplete); under min when complete                                          | under min, incomplete → `insufficient_evidence`                                                                               |

`after:`-scoped checks evaluate these same semantics over the events after the first
`after`-match; a window that never opens is `na` by completeness for all three types.

## 8. Orchestration (`judgeTrajectory`, per meta-behavior)

1. Empty trajectory → whole judgment `na`/`insufficient_evidence`, zero LLM calls.
2. **Trigger gate** (a trigger can NEVER produce a `false` meta verdict — only "run the
   checks" or "na with reason"): predicate trigger no-match → `na` (`not_applicable` if
   complete, `insufficient_evidence` if not), skip everything. Semantic trigger → one
   scoped LLM call (mechanically a semantic check with a synthesized "did this condition
   occur" question); LLM `false` means condition never fired → `na`/`not_applicable`.
3. All predicate checks evaluate (free), citing deciding events.
4. **Verify-on-false**: each predicate `false` → one `buildVerifyFalseMessages` call.
   Verifier `false` → clause stays false, `verification: "confirmed"`. Verifier
   `true`/`na` → clause takes verifier's verdict+citations, `verification: "overturned"`,
   original kept in `predicateVerdict: "false"`. Offline or `--no-verify` →
   `verification: "unverified"`, verdict stays false.
5. Any surviving `false` → meta verdict false, **skip semantic checks**.
6. Otherwise each semantic check = one scoped LLM call (offline → `na`/
   `insufficient_evidence` clause with explanatory reasoning).
7. Meta verdict = `foldBehaviorVerdicts(clauseVerdicts)`; file verdict = fold over metas.
   Fold: any `false` → `false`; all `na` → `na`; else `true` (note `[true, na]` → `true`).

Rationale for verify-on-false: matchers are exact about events but approximate about
clause meaning (an unrelated `web_search` before `read_skill` trips the ordering check
without violating "source research"), and a single false gates the file verdict — the
one place a cheap confirmation call pays for itself.

Deliberately NOT done (v0 scope decisions): LLM confirmation of `true` predicate verdicts
(would reinstate the LLM as main judge), a holistic `--sweep` residual pass (deferred;
calibration disagreements reveal IR blind spots), a `freshness` predicate type (the
discriminated union makes it a one-case addition later), synthetic trajectory generation
for `generate` (would bind predicates to unverified vocabulary).

## 9. LLM contract and Braintrust wrapper

All LLM responses go through `completeJsonWithRetry`: parse/validate → on failure, retry
ONCE with the validation error appended → second failure throws. `parseSemanticResult`
enforces: verdict ∈ {true,false,na}; `na_reason` ∈ {not_applicable, insufficient_evidence}
iff na (the third `NaReason`, `behavior_not_judgeable`, is kept in the type for compat
but never emitted); non-empty reasoning; ≥1 citation with event IDs that exist in the
trajectory. Trajectories are declared untrusted data in the system prompt (prompt-
injection hardening); judges attempts/conduct, not outcomes.

Braintrust is a **model wrapper only**: `gateway.ts` does one `fetch` to
`{baseUrl}/chat/completions` (OpenAI-compatible). Env: `BRAINTRUST_API_KEY`,
`BRAINTRUST_JUDGE_MODEL`/`BRAINTRUST_MODEL` (default `gpt-5-mini`),
`BRAINTRUST_GATEWAY_BASE_URL` (default `https://gateway.braintrust.dev`), temperature
pinned 0. The CLI fills `process.env` from the nearest `.env` at or above cwd
(already-set variables win; see `env.ts`). **Offline mode** (no key): predicates still
run, semantic clauses → `na`, falses stay `unverified`; only `generate` truly requires
an LLM. The `JudgeCompletion` seam (`(messages) => Promise<string>`) bypasses the
gateway entirely — how all tests run.

## 10. `generate` flow (spec → judge.yaml)

1. `loadBehaviorSpec` (frontmatter + body; no full standard validation). Requires ≥1
   sample trajectory (hard error otherwise).
2. `extractVocabulary`: per action → actors, metadata keys w/ example values, one sample
   event.
3. **One proposal LLM call**. `parseProposal` trick: wrap response JSON in
   `{version: 1, behavior, metaBehaviors}` → `stringifyYaml` → strict `parseIr` — reuses
   the IR validator so malformed proposals get path-labeled errors feeding the retry.
   Then `normalizeProposal` capitalizes the first character of predicate trigger
   descriptions and semantic check questions (semantic trigger descriptions are left
   untouched — they feed judge-time question synthesis).
4. Unobserved-vocabulary flagging (code-side, never trusts the model): matchers
   referencing an action/metadata key absent from the samples are detected via
   `vocabularySets`/`unobservedInTrigger`/`unobservedInCheck` and get a printed
   `warning:` line in the interview — the human decides keep/demote/drop (accepting
   asserts the instrumentation emits that vocabulary; the proposal prompt allows
   spec-implied unobserved vocabulary, e.g. forbidden actions clean samples never show).
   `contentIncludes` is never vocabulary-checked.
5. Interview (single-letter answers, empty = first option): if spec had no H2s, confirm/
   rename/drop proposed names; per meta: trigger `[y/s/e]` with first matching sample
   event as evidence; each check `[y/s/d]`; each semantic check `[y/e/d]`. Evidence lines
   show the matched event's id plus the metadata values the matcher binds to and its
   whitespace-flattened content clipped to 80 chars; a no-match on a `forbidden` matcher
   is labeled expected. Edit prompts (rename, trigger description, semantic question)
   pre-fill the readline buffer with the current text for in-place editing (TTY only;
   the `ask` seam takes an optional `prefill`); retyped predicate trigger descriptions
   and semantic questions are capitalized like proposed ones. Metas with nothing left
   are dropped. Reject = demote-or-drop, never regenerate.
6. Print YAML, final `[y/n]`, CLI writes to `--out` (default `judge.yaml` next to
   `BEHAVIOR.md`).

## 11. Fixtures and tests

Three example dirs under `examples/`, each holding `BEHAVIOR.md`, a checked-in
`judge.yaml`, and labeled `{trajectory, expected}` JSONs under `trajectories/` —
ready-to-run CLI inputs for `generate`/`judge`/`calibrate`:

- `primary-source-tax-research/` — the semantic showcase (semantic trigger + semantic
  check). Its `judge.yaml` is the reference IR fixture for `ir.test.ts`/`judge.test.ts`
  via relative URL. `src/taxFixtures.ts` is the same six cases as TS data for tests
  (regenerate the JSONs on fixture changes).
- `verified-refund-support/` and `staged-rollout-deploys/` — **predicate-only** examples
  (all triggers and checks deterministic; between them they cover all five predicate
  types plus `after:`, `distinctBy`, `contentIncludes`, and any-of patterns).
  `src/examples.test.ts` re-derives every checked-in expected verdict offline with a
  throwing completion seam — if you edit these fixtures or IRs, the expected labels must
  stay reproducible with zero LLM calls. Their trajectories are deliberate traps for
  holistic LLM judges (buried forbidden events, distinct-count, attempts-vs-outcomes,
  claim-vs-event, incomplete-trace na discipline); per-example READMEs record measured
  calibration comparisons plus fairness notes (adversarial composition disclosed; the
  one convention-dependent incomplete-trace case per example is labeled as such).
- `scripts/upstream-calibrate.mjs` — self-contained port of the upstream repo's one-call
  LLM example judge (Apache-2.0 attribution in header); reads the same labeled fixture
  files and prints the same agreement report as `calibrate`, so the two judging
  architectures can be compared case for case (`--runs N` repeats trials, `--json`
  emits machine-readable runs). `scripts/agreement-stats.mjs` aggregates repeated
  `--json` runs from either judge into mean agreement with a 95% CI, perfect-run
  counts, verdict-consistency rates, and a per-slot miss breakdown
  (`--convention-cases` tallies the convention-dependent cases separately). Keep
  BEHAVIOR.md paragraphs unwrapped (one line per paragraph, like all three examples):
  the upstream judge must quote violated clauses verbatim from the H2, and mid-sentence
  hard wraps make that mechanically impossible.

Tax fixture cases:
`secondary-then-primary` (pass), `primary-directly` (pass; secondary research is optional
routing, not ritual), `skill-read-too-late` (meta1 false), `secondary-only` (meta2
false), `correct-without-research` (meta1 na — trigger never fires; meta2 false — right
answer, no research), `tax-adjacent-writing` (all na — not a tax question).

Reference IR design notes: meta 1 trigger is a predicate (`web_search`/`open_url` —
agent events = "begins source research") → the common case costs zero LLM. Meta 2
trigger is semantic because no event pattern can detect "answers a **tax** question" —
matching `final_answer` would wrongly trigger on `tax-adjacent-writing`. Meta 2's
ordering check matches `open_url_result` + `metadata.sourceType: primary` (the result,
not the attempt, carries source type) before `final_answer`.

Test suite (zero network, `queuedCompletion` fake returning scripted JSON):

- `predicates.test.ts` — every predicate type × every na/incomplete branch.
- `ir.test.ts` — round-trip of the checked-in reference IR + strict-parse rejections +
  fold table.
- `judge.test.ts` — **executable spec of the LLM-call economy**: asserts exact call
  counts for trigger gating, verify-on-false, overturn-then-semantics, no-verify/offline,
  retry-once (bad-then-good ok; bad-bad throws), unknown-event citations rejected; plus
  reproduction of fixture verdicts from the checked-in `judge.yaml`. Don't add LLM calls
  without updating it.
- `examples.test.ts` — round-trips the two predicate-only example IRs and re-derives
  every expected verdict in their trajectory files offline (throwing completion seam,
  `verify: false`): the checked-in labels ARE the deterministic layer's output.
- `spec.test.ts` — loader happy paths (file, directory) + every rejection branch.
- `env.test.ts` — nearest-`.env` discovery, parsing, and already-set-variables-win.
- `generate.test.ts` — vocabulary extraction, unobserved-vocabulary flagging, scripted
  interviews (answer sequences are order-sensitive; count prompts carefully when editing).
- `cli.test.ts` — `captureMain` + `mkdtemp` temp dirs for all three commands, exit codes,
  help/version/unknown-command.

## 12. Extension points

- **New predicate type** (e.g. `freshness`): add a case to the `PredicateCheck` union in
  `ir.ts`, a branch in `parseCheck` + `evaluatePredicate`, prompt mention in
  `generate.ts`'s `PROPOSAL_SYSTEM_PROMPT`, tests.
- **Trace-format ingestion** (OTel spans, Braintrust logs → `TrajectoryEvent[]`): slots
  in at `loadTrajectoryFile` without touching judging.
- **Other LLM providers**: change `BRAINTRUST_GATEWAY_BASE_URL` (any OpenAI-compatible
  endpoint) or pass a custom `complete` via library API / CLI `deps`.
