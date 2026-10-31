#!/usr/bin/env bash
# Download the otel-html release binary for this runner, verify it against the release's SHA256SUMS and put it on PATH.
# Usage: install.sh <version|latest>   Env: REPO (owner/name of the release repository), GH_TOKEN, RUNNER_OS, RUNNER_ARCH, RUNNER_TEMP, GITHUB_PATH,
# and ACTION_REF (the ref the action was used at, such as `v0`; default $GITHUB_ACTION_REF).
#
# `latest` used from a floating major tag (`@v0`) is the newest release of that major, so `@v0` never installs a 1.x
# binary; otherwise it is the repository's latest release.
set -euo pipefail

version="${1:-latest}"
: "${REPO:?REPO is required}"

case "$RUNNER_OS/$RUNNER_ARCH" in
  Linux/X64) target=linux-x64 ;;
  Linux/ARM64) target=linux-arm64 ;;
  macOS/X64) target=darwin-x64 ;;
  macOS/ARM64) target=darwin-arm64 ;;
  Windows/X64) target=windows-x64 ;;
  *)
    echo "::error::otel-html has no release binary for $RUNNER_OS/$RUNNER_ARCH" >&2
    exit 1
    ;;
esac
asset="otel-html-$target"
installed="otel-html"
if [ "$RUNNER_OS" = Windows ]; then
  asset="$asset.exe"
  installed="otel-html.exe"
fi

action_ref="${ACTION_REF:-${GITHUB_ACTION_REF:-}}"
if [ "$version" = latest ] && [[ $action_ref =~ ^v([0-9]+)$ ]]; then
  major=${BASH_REMATCH[1]}
  tags=$(gh release list -R "$REPO" --limit 200 --exclude-drafts --exclude-pre-releases --json tagName --jq '.[].tagName')
  tag=$(printf '%s\n' "$tags" | grep -E "^otel-html-v$major\.[0-9]+\.[0-9]+\$" | sort -V | tail -n 1 || true)
  if [ -z "$tag" ]; then
    echo "::error::$REPO has no otel-html-v$major.* release for @$action_ref" >&2
    exit 1
  fi
elif [ "$version" = latest ]; then
  tag=$(gh release view -R "$REPO" --json tagName --jq .tagName)
else
  tag="otel-html-v${version#v}"
fi
case "$tag" in
  otel-html-v*) ;;
  *)
    echo "::error::the latest release of $REPO is $tag, not an otel-html-v* release" >&2
    exit 1
    ;;
esac
echo "installing $asset from $REPO $tag"

work="$RUNNER_TEMP/otel-html-download"
bin="$RUNNER_TEMP/otel-html/bin"
rm -rf "$work"
mkdir -p "$work" "$bin"
gh release download "$tag" -R "$REPO" -D "$work" -p "$asset" -p SHA256SUMS
# Fail closed when SHA256SUMS has no line for the asset, whatever the coreutils version does with --ignore-missing.
grep -Eq "^[0-9a-f]{64} [ *]${asset//./\\.}\$" "$work/SHA256SUMS" || {
  echo "::error::no checksum for $asset in SHA256SUMS" >&2
  exit 1
}
# The binary keeps its release file name for the check; SHA256SUMS lists every platform, so ignore the missing ones.
(cd "$work" && sha256sum -c --ignore-missing SHA256SUMS)
mv "$work/$asset" "$bin/$installed"
chmod +x "$bin/$installed"
if [ "$RUNNER_OS" = Windows ]; then
  # git-bash paths mean nothing to later steps' shells; GITHUB_PATH wants a Windows path.
  bin=$(cygpath -w "$bin")
fi
echo "$bin" >> "$GITHUB_PATH"
