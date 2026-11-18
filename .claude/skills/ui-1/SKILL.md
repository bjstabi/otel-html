---

name: ui-1
description: Continue the CI dashboard UI project (the sketched CI dashboard built in the viewer: format 8 cicd table, page filter bar and range slider, cicd widget type, the open run) from wherever it stands. Use when the maintainer types /ui-1 or asks to continue, resume or kick off the CI dashboard UI or dashboard redesign work after clearing context.
---

# Continue the CI dashboard UI work

1. `git fetch origin`, then `git switch main && git pull --ff-only`. If a branch of this project is checked out with
   uncommitted work, say so and ask before switching.
2. Read §12, "Sessions for `/ui-1`", of `docs/superpowers/specs/2026-11-18-ci-dashboard-ui-design.md`. It states the
   rules for deciding which session is next (an open PR of the project is finished first; 0: the design awaits the
   maintainer's answers; B: execute the plan; after the plan's last PR is merged or marked dropped the work is
   complete and the skill says so) and carries each session's prompt.
3. Apply the rules with `gh pr list --base main --state open`, the document's status line,
   `ls docs/superpowers/plans/` and `gh pr list --base main --state all --head <branch>` for the branches the plan's
   PR table names. Tell the maintainer which session you picked and why, in two lines.
4. Run that session's prompt exactly as written there, invoking the superpowers skill it names
   (superpowers:subagent-driven-development to execute the plan). The PR process is unattended
   (`docs/agents/process-unattended.md`); PRs target `main`. Models per CLAUDE.md.
5. Bugs found while building are fixed in the PR being built and listed under **Also**; no issue is opened for them
   (the maintainer's rule for this project, 2026-11-18).
6. Nothing is built while the design's status line says it awaits the maintainer's answers: session 0 only asks,
   records the answers and merges the updated documents.
7. A session that changes what the next session has to do (a split PR, a changed process, a decision the maintainer
   made on the way) updates §12 in the same commit, so the next `/ui-1` finds it.
