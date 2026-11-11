---

name: perf-1
description: Continue the query-scaling project (query catalogue and scaling tests, small files in parallel, pruning, rollups, default window) from wherever it stands. Use when the maintainer types /perf-1 or asks to continue, resume or kick off the query-scaling or report-performance work after clearing context.
---

# Continue the query-scaling work

1. `git fetch origin`, then `git switch main && git pull --ff-only`. If a branch of this project is checked out with
   uncommitted work, say so and ask before switching.
2. Read §11, "Sessions for `/perf-1`", of `docs/superpowers/specs/2026-11-11-query-scaling-design.md`. It states the
   rules for deciding which session is next (an open PR of the project is finished first; 0: the design awaits
   approval; A: write the plan; B: execute it; after the plan's last PR is merged or marked dropped the work is
   complete and the skill says so) and carries each session's prompt.
3. Apply the rules with `gh pr list --base main --state open`, the document's status line,
   `ls docs/superpowers/plans/` and `gh pr list --base main --state all --head <branch>` for the branches the plan's
   PR table names. Tell the maintainer which session you picked and why, in two lines.
4. Run that session's prompt exactly as written there, invoking the superpowers skill it names
   (superpowers:writing-plans to write the plan, superpowers:subagent-driven-development to execute it). The PR
   process is unattended (`docs/agents/process-unattended.md`); PRs target `main`. Models per CLAUDE.md.
5. Nothing is built while the design's status line says it awaits approval: session 0 only asks, records the answers
   and merges the updated document.
6. A session that changes what the next session has to do (a split plan, a changed process, a decision the
   maintainer made on the way) updates §11 in the same commit, so the next `/perf-1` finds it.
