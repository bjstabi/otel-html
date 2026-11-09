---

name: format-4
description: Continue the format-4 project (Parquet partitions, DuckDB in the browser, incremental CI publishing) from wherever it stands. Use when the maintainer types /format-4 or asks to continue, resume or kick off the format-4 work after clearing context.
---

# Continue the format-4 work

1. `git fetch origin`. If `gh pr list --head feat/format-4 --base main --state merged` lists the release PR, work from
   `main` (`git switch main && git pull --ff-only`). Otherwise `git switch feat/format-4` (create it tracking
   `origin/feat/format-4` if it is missing locally) and `git pull --ff-only`.
2. Read the "Kickoff prompts" section at the top of `docs/superpowers/plans/2026-11-06-format-4-writer.md`. It states the
   rules for deciding which session is next (A: execute plan 1; B: write plan 2; C: execute plan 2; D, E: plans 3 and 4;
   F: the release PR; G: write the publishing plan; H: execute it; after H the work is complete and the skill says so)
   and carries each session's prompt.
3. Apply the rules with `git log origin/feat/format-4` (or `origin/main` once the release PR has merged),
   `ls docs/superpowers/plans/` and `gh pr list --base feat/format-4 --state all`. Tell the maintainer which session you picked and why, in two lines.
4. Run that session's prompt exactly as written there, invoking the superpowers skill it names
   (superpowers:subagent-driven-development to execute a plan, superpowers:writing-plans to write one). The PR process is
   unattended (`docs/agents/process-unattended.md`); PRs target `feat/format-4`, not `main`, unless the release PR has merged (step 1); then they target `main`. Models per CLAUDE.md.
5. A planning session adds the execution prompt of the plan it wrote to that same "Kickoff prompts" section and
   commits it, so the next `/format-4` finds it.
