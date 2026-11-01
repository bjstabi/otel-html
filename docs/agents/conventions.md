# Conventions for code that lands here

Shared by every PR process in this folder. Short on purpose; the README and the code are the reference.

## Branches, commits, pull requests

- Branch from `main`, named `<type>/<topic>` (`fix/writer-idle-checkpoint`, `ci/parallel-jobs`).
- Commits are conventional (`feat(viewer): …`, `fix(receiver): …`, `test(e2e): …`, `ci: …`, `chore(mise): …`,
  `docs: …`); commitlint enforces it. A commit message ends with the trailers the session supplies
  (`Co-Authored-By`, `Claude-Session`).
- The repository **squash-merges**: the PR title is the conventional commit that lands on `main`, and release-please
  reads it. `feat` and `fix` change the version; `!` marks a breaking change.
- The PR body carries: `Fixes #N` for every issue it closes (one line each); per issue, what changed and what was
  decided against; an **Also** list for anything fixed on the way; the measurements the plan asked for.
- One PR per plan section; the plan's PR table names the branch and the title. Branch the next PR from the updated
  `main` after the previous one merged when the plan says they are sequential.

## Code

- TypeScript strict as `tsconfig.base.json` has it: no `any`, no non-null assertions, exhaustive `switch` through
  `never`, errors are typed `OtelHtmlError`s. Biome strict at error (`mise run format` fixes formatting).
- No new dependency without saying so in the PR body and the plan. Pinned versions (`save-exact`).
- Public API (`src/api/index.ts`) and the report format change only where a plan says so.
- The README is the product documentation: a behaviour change updates it in the same PR.

## Tests

- TDD per task: write the failing test, run it and see it fail, implement, run it and see it pass, commit.
- Unit tests live in `test/`, mirroring `src/`; one file is `pnpm exec vitest run <file>`. Timing-sensitive tests
  carry `@perf` and run only in the perf pass (`OTEL_HTML_PERF_PASS=1`); never loosen a budget to make one pass.
- E2E specs live in `e2e/`; one spec is `mise run test:e2e:chromium -- e2e/<spec>.spec.ts`. A viewer behaviour
  that needs a real browser (canvas, keyboard, URL state) is an e2e test; logic is a unit test.
- Before each commit run `pnpm exec biome check .` and `mise run typecheck` by hand, not through a pipe that hides
  the exit status. Before a push, `mise run check`; before opening a PR, the Chromium e2e suite as well (the ladder
  in AGENTS.md).
- Tasks are documented in their `description` in `mise.toml` (`mise tasks info <task>`), never in a README table;
  a new or changed task updates its description in the same commit.
- Receiver tests bind port 0 on `127.0.0.1` and close servers in `afterEach`.

## Findings on the way

- Something small and related: fix it in the same PR and list it under **Also**.
- Something that changes a public interface, needs a measurement the PR cannot make, or belongs to another area:
  open an issue (`gh issue create`), link it from the PR body, move on.
- A decision the plan left open: stop and ask, whatever the PR process.
