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
behavior-judge generate  <behavior-path> <trajectory.json ...> [--update <ir.yaml>] [--out <file>] [--model <m>] [--web]
behavior-judge judge     <ir.yaml> <trajectory.json ...> [--json] [--model <m>] [--no-verify] [--web]
behavior-judge calibrate <ir.yaml> <trajectory.json ...> [--json] [--model <m>] [--no-verify]
```

Exit codes: `judge` 0 on successful run; `calibrate` 1 on any expected/actual
disagreement (CI gate); `generate` 1 if the user declines the final confirm. Errors → 1.
`generate --update <ir.yaml>` is the diff-scoped re-interview after a spec edit (§10);
`--out` then defaults to the `--update` path. `generate --web` serves the interview to
a browser instead of readline (§10a); it does not combine with `--update` yet (the CLI
rejects the pair). `judge --web` serves the report to a browser (§10b); it rejects
`--json` (one format at a time), and `calibrate` does not support `--web` yet.

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
- `generate.ts` — H2 extraction (`splitSpecSections`/`normalizeSectionBody`),
  `extractVocabulary`, proposal prompt + `parseProposal`, unobserved-vocabulary flagging
  (`vocabularySets`/`unobservedInTrigger`/`unobservedInCheck`), and the presenter-based
  interview: `prepareInterview` (one proposal LLM call) + `runProposalInterview`
  (deterministic driver: walks the proposal, asks an `InterviewPresenter` one structured
  step at a time, owns all demote/drop/edit/capitalization rules, and records each kept
  meta's section body as `source`) + `createTextPresenter` (the readline rendering) +
  `runInterview` (seams: `complete`/`ask`/`write`; = prepare → drive with the text
  presenter). Also exports deps-based per-item helpers (`interviewTrigger`/
  `interviewChecks`/`interviewSemanticChecks`) that wrap the same review logic in a
  one-off text presenter — `update.ts` reuses them. New interview frontends implement
  `InterviewPresenter`, never fork the driver.
- `update.ts` — diff-scoped regeneration behind `generate --update`: `planUpdate` maps
  existing metas onto the edited spec's sections via the recorded `source` bodies
  (unchanged/changed/added + removed), `computeSectionDelta` splits a changed
  section's clauses into carried/dropped/new by verbatim quote survival, one scoped
  proposal call covers all changed+added sections, one demote-only triage call per
  changed section flags carried clauses the edit may have re-scoped, and
  `runUpdateInterview` asks only about the deltas. Readline-only for now (`--web`
  rejects `--update`).
- `env.ts` — nearest-`.env` discovery (`loadNearestDotEnv`/`applyNearestDotEnv`): the CLI
  fills `process.env` from the closest `.env` at or above cwd; already-set variables win.
  CLI-only concern, not exported from `index.ts`; `cli.test.ts`'s `captureMain` stubs the
  `CliDeps.loadEnv` seam so the repo's real `.env` never leaks into tests.
- `webInterview.ts` — the `--web` presenter: 127.0.0.1-only `node:http` server, one-time
  token on every route, SSE state pushes + JSON answer posts, back-navigation by
  answer-replay (§10a). CLI-only concern, not exported from `index.ts`.
- `webInterviewPage.ts` — the single-file browser page served by `webInterview.ts`
  (inline CSS/JS in one template literal; the embedded script avoids backticks and
  `${` so the literal needs no escaping; all dynamic text rendered via DOM APIs, never
  innerHTML).
- `webReport.ts` — the `judge --web` server: same 127.0.0.1/one-time-token/SSE posture
  as `webInterview.ts`; pushes per-case judging progress then the final report, and
  blocks until the page posts `/ack` (§10b). Judging stays in judge.ts (the CLI passes
  a `judgeCase` seam). CLI-only concern, not exported from `index.ts`.
- `webReportPage.ts` — the single-file report page served by `webReport.ts`; same
  conventions and visual language as `webInterviewPage.ts`.
- `cli.ts` — dispatch, report formatting, readline wiring, browser opener, `CliDeps`
  injection.
- `index.ts` — public exports. `taxFixtures.ts`, `webInterviewTestClient.ts`,
  `webReportTestClient.ts` — test-only helpers (tax cases as TS data; SSE clients
  standing in for the two browser pages). None are packed/exported.

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
    source: <normalized H2 section body> # optional, machine-maintained
```

- **Naming:** `EventMatcher` = one pattern, AND across its fields (`action`/`actor`/
  `contentIncludes`/`metadata`). `EventPattern` (TS type) = one matcher or an array
  meaning **any-of** (OR). YAML keys stay `match:`/`first:`/`before:`/`each:`/`followedBy:`/`after:`.
- Every check carries a verbatim `quote` from the spec (traceability requirement).
- `source` (optional) records the normalized spec section body the meta was last
  generated or reviewed against; `generate --update` compares it against the current
  spec to carry unchanged sections without questions. `generate` writes it for H2 specs;
  don't hand-edit it. Judging ignores it.
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
6. Each kept meta records its H2 section body (normalized) as `source` — the anchor
   `--update` diffs against later. Print YAML, final `[y/n]`, CLI writes to `--out`
   (default `judge.yaml` next to `BEHAVIOR.md`).

### `generate --update <existing.yaml>` (diff-scoped re-interview, `update.ts`)

After a spec edit, re-interviews only what changed instead of re-running the full flow.
All change detection is deterministic and code-side; the two LLM calls it can make are
scoped and validated, and neither can shrink the review:

- **Plan** (`planUpdate`): per current-spec section — body equals the meta's recorded
  `source` → carried verbatim, zero questions, zero LLM; new heading → proposed and
  interviewed like plain generate; section gone → meta dropped with a note (a pure
  heading rename therefore reads as removed + added and re-interviews that one section).
  A meta without `source` (e.g. a hand-written IR) is conservatively treated as changed.
  A spec with no H2s is an error (run plain generate). Nothing changed → zero LLM calls,
  one final confirm.
- **One shared proposal call** covers all changed+added sections (changed ones include
  the previous meta IR and "revise minimally"); `parseUpdateProposal` reuses
  `parseProposal` then enforces exactly the requested names and every quote verbatim in
  its section, feeding the retry.
- **Mechanical delta** (`computeSectionDelta`) for a changed section: existing clauses
  whose quotes survive verbatim are carried **from the existing yaml** (proposal drift
  for a surviving quote is discarded — the human already approved that clause, and hand
  edits survive); vanished quotes drop with a note; proposal clauses with new quotes are
  interviewed normally. Predicate triggers compare by match pattern (description is
  cosmetic), semantic triggers by description; a differing trigger gets a
  `[y/p/s/e]` question (`p` = keep previous).
- **Demote-only triage**, one call per changed section with carried clauses: given the
  old (`source`) and new section texts, the model flags carried clauses the edit may
  have re-scoped (e.g. a redefined term a matcher relies on). `re_ask` moves a clause
  from the batch confirm to an individual question with the reason printed; the model
  cannot expand the carried set or alter clauses. Echo-back validation: every listed id
  exactly once, verdict enum, non-empty reason. No `source` → triage impossible → every
  carried clause is re-asked (the safe ceiling).
- Unflagged carried clauses get one batch confirm (`Keep these? [y/n]`); `n` falls
  through to individual review of each.
- `--out` defaults to the `--update` path. Run `calibrate` afterwards: it is the safety
  net for a carried clause whose meaning drifted past both the quote check and triage.

Steps 5–6 are one deterministic driver (`runProposalInterview`) speaking to an
`InterviewPresenter`; the readline flow above is `createTextPresenter`, whose output is
the CLI contract `generate.test.ts` scripts against.

## 10a. `generate --web` (browser presenter over the same driver)

- `runWebInterview` (webInterview.ts): binds `node:http` to 127.0.0.1 on a random port,
  prints the URL (containing a 128-bit one-time token — required on every route,
  compared with `timingSafeEqual`), opens the browser (`CliDeps.openBrowser` seam;
  platform `open`/`xdg-open`/`start` default), then runs prepare → drive exactly like
  the text path. `writeIr` runs before the success screen is shown, so the page never
  claims a file exists that wasn't written.
- Protocol: `GET /` page; `GET /events` SSE pushing `{revision, behavior, state}`
  snapshots (state: `loading` → `step` (stepId + `canGoBack` + sanitized payload;
  evidence content clipped to 200 chars) → `done`/`error`); `POST /answer`
  `{stepId, answer}` (409 stale/mismatched step, 400 malformed answer — validated
  per step kind server-side); `POST /back`.
- **Back-navigation = answer replay.** The driver is deterministic given
  (proposal, answers), so the session records every answer; back pops the last one,
  rejects the pending step with a `RestartSignal`, and re-runs the driver from the
  cached proposal — recorded answers replay instantly, the model is never re-asked,
  and terminal notes are suppressed during replay (only logged at the live frontier).
- The page (webInterviewPage.ts) is one sequential card per step: matchers rendered as
  natural-language chips (humanized action names, actor/metadata/contentIncludes as
  sub-lines, any-of as "or"), ordering/pairing as first→before / each→followedBy flow
  diagrams, `after:` as an "only applies after" strip, sample events in a dark
  code-aesthetic evidence panel (no trajectory/event-id provenance — that stays a CLI
  concern), unobserved-vocabulary warnings as amber callouts, edit-in-place for
  descriptions/questions/names, and a replay-backed back button. It holds no interview
  logic — it renders whatever step the server pushes.
- Aborting: cancel on the confirm card → done screen, `Aborted; nothing written.`,
  exit 1 (same as declining `[y/n]`). Ctrl-C in the terminal kills the server outright.

## 10b. `judge --web` (browser report over the same server posture)

- `runWebReport` (webReport.ts): binds 127.0.0.1 on a random port, prints the token
  URL, opens the browser, then judges the cases one at a time through the CLI's
  `judgeCase` seam (so `--model`/`--no-verify` and the stderr progress lines work
  unchanged). SSE states: `judging` `{done, total, judgingId, judgments-so-far}` per
  case → `report` → `error`. Judgments are append-only across snapshots, so the page
  renders cards incrementally and never re-renders one (user-opened rows survive).
- **Ack handshake**: the page posts `/ack` once the final report has rendered (409
  before the report state exists); that resolves `runWebReport`, the server shuts
  down, and the CLI prints the plain-text report to stdout as the durable copy. No
  browser → the CLI blocks, like an unanswered interview; Ctrl-C aborts.
- The payload is humanized code-side, never trusting the page with raw internals:
  predicate clauses are zipped in order with the IR meta's checks to recover each
  check's type, trigger descriptions ride along from the IR, and citations are
  enriched with the cited event's actor/action/content (clipped to 200)/metadata.
  Predicate citation descriptions (generated boilerplate) are dropped; model-written
  ones (semantic clauses, overturned verdicts) are kept.
- The page: one card per run with pass/fail/no-verdict pills, an amber strip for
  incomplete runs, a details row per rule (failing rules pre-opened, trigger shown as
  "applies when"), per-clause verdict marks with plain-language check-type tags,
  verification notes, model reasoning, and cited events in the dark evidence panel.
  Event ids are shown here (a report is provenance), unlike the interview page.

Three example dirs under `examples/`, each holding `BEHAVIOR.md`, a checked-in
`judge.yaml`, and labeled `{trajectory, expected}` JSONs under `trajectories/` —
ready-to-run CLI inputs for `generate`/`judge`/`calibrate`. All three `judge.yaml`s
carry per-meta `source` fields (so `--update` works on them out of the box);
`examples.test.ts` asserts every `source` byte-matches its BEHAVIOR.md section, so
editing a spec means refreshing the IR's `source` too:

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
- `generate.test.ts` — vocabulary extraction, unobserved-vocabulary flagging, section
  splitting/normalization, `source` attachment, scripted interviews (answer sequences
  are order-sensitive; count prompts carefully when editing). Scripts the text presenter
  through `runInterview`, so it also pins the readline rendering of the presenter
  refactor.
- `update.test.ts` — plan classification (unchanged/changed/added/removed,
  no-source → changed), delta rules (quote survival, drift discarded, drops), update
  proposal validation, triage echo-back parsing, and scripted update interviews:
  unchanged spec → zero LLM calls and only the final confirm, delta-only questioning
  with batch confirm, triage re-ask with reason, batch decline fall-through,
  keep-previous trigger, no-source re-review, triage retry-once.
- `webInterview.test.ts` — real loopback HTTP against `runWebInterview` via
  `webInterviewTestClient.ts`: step payload shapes, accept-all to written file,
  back/replay (asserts exactly one proposal completion), cancel-writes-nothing, token
  403s, stale/malformed answer 409/400s, server teardown on proposal failure.
- `webReport.test.ts` — real loopback HTTP against `runWebReport` via
  `webReportTestClient.ts`: gated judging→report snapshot flow, payload enrichment
  (check types, cited-event content, predicate boilerplate dropped vs model
  descriptions kept, untriggered-meta trigger clauses), premature-ack 409, token 403s,
  error-state push and server teardown on judging failure.
- `cli.test.ts` — `captureMain` + `mkdtemp` temp dirs for all three commands, exit codes,
  help/version/unknown-command, `generate --update` (in-place, zero-call unchanged path),
  generate and judge `--web` end-to-end through the `openBrowser` seam (browser stand-ins
  drive the interview / ack the report over HTTP while `main` blocks), and the
  `--web`/`--update`, `--web`/`--json`, and `calibrate --web` rejections.

## 12. Extension points

- **New predicate type** (e.g. `freshness`): add a case to the `PredicateCheck` union in
  `ir.ts`, a branch in `parseCheck` + `evaluatePredicate`, prompt mention in
  `generate.ts`'s `PROPOSAL_SYSTEM_PROMPT`, tests.
- **Trace-format ingestion** (OTel spans, Braintrust logs → `TrajectoryEvent[]`): slots
  in at `loadTrajectoryFile` without touching judging.
- **Other LLM providers**: change `BRAINTRUST_GATEWAY_BASE_URL` (any OpenAI-compatible
  endpoint) or pass a custom `complete` via library API / CLI `deps`.
