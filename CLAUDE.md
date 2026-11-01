@AGENTS.md

# Claude-specific

- Models: implementers and per-task reviewers run on Sonnet 5.5; whole-branch reviews run on Opus 5.5 (the
  maintainer's standing preference). State the model a review ran on in its summary.
- Planning and execution follow the superpowers skills (brainstorm → spec in `docs/superpowers/specs/` → plan in
  `docs/superpowers/plans/` → subagent-driven or inline execution). The plan names the PR process it was written
  for; if it does not, ask (see AGENTS.md).
