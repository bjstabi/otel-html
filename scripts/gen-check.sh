#!/usr/bin/env bash
set -euo pipefail
mise run gen
git diff --exit-code -- src/model/gen 'src/ottl/*.gen.ts'
