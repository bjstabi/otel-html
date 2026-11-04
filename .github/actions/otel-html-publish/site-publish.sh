#!/usr/bin/env bash
# Runs `ci site` (site-lease.sh's command) and then, for a default-branch report that was rebuilt, screenshots it.
#
#   site-publish.sh <site> <command...>
#
# The command's failure is the wrapper's. After it, when PREVIEW_COMMAND is not empty and the command wrote
# `channel=branch/…` and `rolling=built` to GITHUB_OUTPUT, `$PREVIEW_COMMAND <site>/<channel>` runs; the screenshots
# are part of the site that site-lease.sh then pushes. A failing preview is a warning, never a failed publish.
#
# PREVIEW_COMMAND is deliberately unquoted: it may be a command with arguments, such as `node preview.mjs`.
set -uo pipefail

[ $# -ge 2 ] || {
  echo "usage: site-publish.sh <site> <command...>" >&2
  exit 2
}
site=$1
shift
"$@" || exit $?

[ -n "${PREVIEW_COMMAND:-}" ] || exit 0
channel=$(grep -E '^channel=' "$GITHUB_OUTPUT" | tail -n 1)
channel=${channel#channel=}
rolling=$(grep -E '^rolling=' "$GITHUB_OUTPUT" | tail -n 1)
if [[ $channel == branch/* && $rolling == rolling=built ]]; then
  # shellcheck disable=SC2086
  $PREVIEW_COMMAND "$site/$channel" || echo "::warning::otel-html preview: the screenshot command failed (exit $?); the report is published without a fresh preview"
fi
exit 0
