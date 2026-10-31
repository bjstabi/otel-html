#!/usr/bin/env bash
# The published site's `gh-pages` branch: a single orphan commit holding the whole site, replaced on every publish.
#
#   site-branch.sh checkout <dir>          clone the branch tip into <dir> (an empty tree when the branch does not
#                                          exist yet) and record the fetched commit in <dir>/.lease
#   site-branch.sh push <dir> <message>    commit <dir> as a new orphan commit and force-push it, but only if the
#                                          branch still points at the leased commit; exit 1 when it moved
#
# A rejected lease means another publish or cleanup got there first: the caller checks out again, re-applies its
# change onto the new tip and pushes again.
#
# Environment: GITHUB_SERVER_URL, GITHUB_REPOSITORY and GITHUB_TOKEN (used only in an http.extraheader scoped to the
# server, never printed). Test hook: SITE_REMOTE_URL, when set, is the remote instead (e.g. a local bare repo) and no
# token is needed.
set -euo pipefail

BRANCH=gh-pages

usage() {
  echo "usage: site-branch.sh checkout <dir> | push <dir> <message>" >&2
  exit 2
}

checkout() {
  local dir=$1 remote
  git init -q -b "$BRANCH" "$dir"
  git -C "$dir" config user.name "github-actions[bot]"
  git -C "$dir" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  echo .lease >>"$dir/.git/info/exclude"

  if [ -n "${SITE_REMOTE_URL:-}" ]; then
    remote=$SITE_REMOTE_URL
  else
    : "${GITHUB_SERVER_URL:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_TOKEN:?}"
    remote="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"
    local basic
    basic=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')
    # The encoded token is not masked by the runner the way the raw token is.
    if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::add-mask::$basic"; fi
    git -C "$dir" config "http.$GITHUB_SERVER_URL/.extraheader" "AUTHORIZATION: basic $basic"
  fi
  git -C "$dir" remote add origin "$remote"

  local status=0
  git -C "$dir" ls-remote --exit-code origin "refs/heads/$BRANCH" >/dev/null || status=$?
  case $status in
    0)
      git -C "$dir" fetch -q --depth 1 origin "refs/heads/$BRANCH"
      git -C "$dir" reset -q --hard FETCH_HEAD
      git -C "$dir" rev-parse FETCH_HEAD >"$dir/.lease"
      ;;
    2)
      # No branch yet: start from an empty tree, and an empty lease means "must not exist" on the push.
      : >"$dir/.lease"
      ;;
    *)
      echo "site-branch: cannot list $BRANCH on the remote (git ls-remote exit $status)" >&2
      exit "$status"
      ;;
  esac
}

push() {
  local dir=$1 message=$2 lease
  lease=$(cat "$dir/.lease")
  # Works whether HEAD is the fetched tip or an unborn branch: the new commit has no parent either way.
  git -C "$dir" symbolic-ref HEAD refs/heads/publish
  git -C "$dir" add -A
  git -C "$dir" commit -q --allow-empty -m "$message"
  if ! git -C "$dir" push -q --force-with-lease="refs/heads/$BRANCH:$lease" origin "HEAD:refs/heads/$BRANCH"; then
    echo "site-branch: push to $BRANCH rejected (it moved since ${lease:-it was found absent})" >&2
    exit 1
  fi
}

case "${1:-}" in
  checkout) [ $# -eq 2 ] || usage; checkout "$2" ;;
  push) [ $# -eq 3 ] || usage; push "$2" "$3" ;;
  *) usage ;;
esac
