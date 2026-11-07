#!/usr/bin/env bash
set -euo pipefail
mise run --force gen
git diff --exit-code -- src/model/gen 'src/ottl/*.gen.ts' 'src/ottl/*.gen.terms.ts' schema docs/format/schema.md README.md
# git diff ignores untracked files; stale or new generated files must fail too.
untracked="$(git status --porcelain --untracked-files=all -- src/model/gen 'src/ottl/*.gen.ts' 'src/ottl/*.gen.terms.ts' schema docs/format/schema.md README.md)"
if [ -n "$untracked" ]; then
  echo "generated files are out of sync with git:" >&2
  echo "$untracked" >&2
  exit 1
fi
