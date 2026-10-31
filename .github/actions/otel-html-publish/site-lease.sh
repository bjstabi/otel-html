#!/usr/bin/env bash
# Applies a change to the gh-pages site and pushes it under a lease, starting over from the new tip when the lease is
# rejected (another publish or a PR cleanup got there first), up to 5 attempts with a growing backoff. So a change is
# always made on the tip it is pushed over, and a cleaned-up PR is never brought back.
#
#   site-lease.sh <dir> <message> <push-when> <command...>
#
# Each attempt checks the tip out into <dir> (see site-branch.sh) and runs <command...>, which changes <dir>, with
# GITHUB_OUTPUT pointing at a scratch file. When <push-when> is not empty, the change is pushed only if the command
# wrote that exact output line (`ci site` writes `published=false` for a run it does not publish, `ci cleanup` `cleaned=false` for a pull request the
# site never had). The scratch outputs
# are appended to the real GITHUB_OUTPUT once the attempt succeeds.
#
# Environment: as site-branch.sh, plus GITHUB_OUTPUT. Test hook: SITE_LEASE_BACKOFF=0 retries without waiting.
set -euo pipefail

[ $# -ge 4 ] || {
  echo "usage: site-lease.sh <dir> <message> <push-when> <command...>" >&2
  exit 2
}
dir=$1 message=$2 push_when=$3
shift 3
site_branch="$(dirname "$0")/site-branch.sh"

out=$(mktemp)
trap 'rm -f "$out"' EXIT
for attempt in 1 2 3 4 5; do
  rm -rf "$dir"
  : >"$out"
  if "$site_branch" checkout "$dir" && GITHUB_OUTPUT=$out "$@"; then
    if { [ -n "$push_when" ] && ! grep -qxF "$push_when" "$out"; } || "$site_branch" push "$dir" "$message"; then
      cat "$out" >>"$GITHUB_OUTPUT"
      exit 0
    fi
  fi
  [ "$attempt" = 5 ] || [ "${SITE_LEASE_BACKOFF:-}" = 0 ] || sleep $((attempt * 2 + RANDOM % 5))
done
echo "::error::could not push to gh-pages ($message) after 5 attempts"
exit 1
