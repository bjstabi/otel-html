#!/usr/bin/env bash
# Download the otel-html release binary for this runner, verify it against the release's SHA256SUMS and put it on PATH.
# Usage: install.sh <version|latest>   Env: REPO (owner/name of the release repository), GH_TOKEN, RUNNER_OS, RUNNER_ARCH, RUNNER_TEMP, GITHUB_PATH.
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

if [ "$version" = latest ]; then
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
# The binary keeps its release file name for the check; SHA256SUMS lists every platform, so ignore the missing ones.
(cd "$work" && sha256sum -c --ignore-missing SHA256SUMS)
mv "$work/$asset" "$bin/$installed"
chmod +x "$bin/$installed"
echo "$bin" >> "$GITHUB_PATH"
