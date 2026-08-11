Read the repo/agent context in @AGENTS.md before working here.

Quick facts:

- pnpm + vite-plus; `pnpm exec vp check --fix` before committing, `vp test --run` for tests.
- Judging policy lives in `src/judge.ts`; `judge.test.ts` is the executable spec of when
  LLM calls are allowed to happen. Don't add LLM calls without updating it.
- The trajectory event schema is a tool convention (from the tax example), not part of
  the Agent Behavior standard.
- `pnpm-workspace.yaml` marks this directory as its own pnpm root — don't delete it.
