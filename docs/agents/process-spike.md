# Process: spike

A throwaway build to learn something: whether an approach works, what a change would cost, what a library does under
our load. Nothing from a spike is merged.

## Rules

- Branch `spike/<topic>` from `main`. No PR. No tests required, no review, no README changes.
- `mise run check` need not pass; say so in the report if it does not.
- Time-box it: the brief says how long or how many attempts. Stop when the question is answered, even if the code
  is ugly.
- Do not touch `release.yml`, `ci-report.yml` or anything that runs with a write token.

## The report

One message in the session, and, if the maintainer asks, a note under `docs/superpowers/specs/` next to the spec it
informs:

- the question, the answer, and the evidence (numbers, a diff, a failing command);
- what it would take to do it properly (files, risks, a size estimate);
- the branch name, so the code can be read; it may be deleted once the report is read.

Keeping any of it is a new request: it goes through a spec and a plan, and is re-implemented with tests under one of
the PR processes, using the spike as a reference, not as a starting diff.
<!-- probe -->
