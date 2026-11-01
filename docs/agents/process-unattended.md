# PR process: unattended

For work the maintainer has handed over whole: a plan is approved, and its PRs merge without waiting for a review on
GitHub. Read [conventions.md](conventions.md) too.

## Roles

- **Implementer:** one fresh subagent per task of the plan, on the implementer model (CLAUDE.md names it).
- **Task reviewer:** a fresh subagent after each task, on the same model, with the task's text and the diff: does the
  code do what the task says, do the tests prove it, does anything violate the conventions.
- **Branch reviewer:** one fresh subagent on the review model before the PR is opened, with the whole branch diff and
  the plan section; it looks for correctness bugs and for what the task reviews could not see across tasks.
- **Coordinator:** the session that runs the plan. It dispatches, reads the reviews, fixes or re-dispatches, opens
  and merges the PRs, and writes the final summary.

## Merging

1. The branch review found nothing blocking (a blocking finding is fixed on the branch and re-reviewed).
2. `gh pr create` with the plan's title and the body the conventions ask for.
3. CI is green. A red CI is fixed on the branch, never merged around; a flaky-looking failure is re-run once and,
   if it fails again, treated as real.
4. `gh pr merge <n> --squash --delete-branch`, the PR title as the commit subject and the body as its message.
5. Branch the next PR from the updated `main`.

## Stop and ask

Stop, say what you found, and wait when:

- the plan left a decision open and you have reached it;
- a change would touch `release.yml`, `ci-report.yml`, the `otel-html-publish` action or anything else that runs
  with a write token on `main`;
- a public API, the report format or a CLI flag would change in a way the plan did not state;
- two reviews disagree and the plan does not settle it;
- a measurement the PR body must carry is worse than the plan's expectation.

Everything else is yours to decide; record the decision in the PR body.

## When the plan is done

Post one summary in the session: each PR's number, title and the measurements it carried; the issues opened on the
way; anything stopped on. Do not open a tracking issue for the summary.
