# PR process: reviewed

For work the maintainer wants to read before it lands. The branch is prepared the same way as in the unattended
process; the difference is who merges. Read [conventions.md](conventions.md) too.

## Before the PR

- Implement task by task with a fresh subagent per task and a task review after each (the roles in
  [process-unattended.md](process-unattended.md) apply up to and including the branch review).
- The branch review's findings are fixed before the PR opens; its summary goes into the PR body under **Review**,
  including what it was unsure about.

## The PR

1. `gh pr create` with the plan's title and the conventions' body. Open it as ready, not draft, unless the plan
   says the maintainer wants to see work in progress.
2. CI must be green before asking for the review. Fix red on the branch.
3. Post one message in the session: the PR link, what to look at first, and any decision you made that the
   maintainer might want to reverse.
4. Stop. Do not merge, do not open the next PR of a sequential plan until the maintainer says so.

## Review comments

- Treat each comment as a question until you have verified it against the code (the `receiving-code-review`
  skill): agree and fix, or explain why not, with evidence. Never a silent change.
- Push fix-ups as separate commits on the branch (the squash merge folds them); reply on the thread with the commit.
- A comment that reopens a plan decision goes back to the maintainer as a question, not a change.

## Merging

The maintainer merges. If asked to merge, use `gh pr merge <n> --squash --delete-branch` with the PR title as the
subject, then branch the next PR from the updated `main`.
