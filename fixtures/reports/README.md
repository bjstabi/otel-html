# Frozen reports

Data folders (`data/**` only; no `assets/`, no `index.html`) written by older otel-html builds, kept byte for byte.
`test/format/compat.test.ts` merges each one with the current build and checks that its totals survive, so a change
that stops reading an older format version fails the tests. Do not regenerate or edit them.

| Folder | `formatVersion` | Written by | Inputs |
| --- | --- | --- | --- |
| `format-1/` | 1 | `68ce54f`, the last commit that writes format 1 (the plan's `1b83faa` predates the CLI) | `fixtures/small.otlp.json`, `fixtures/metrics.otlp.json` |
| `format-2/` | 2 | `01d0e53`, the first commit that writes format 2 (the last is `858f1fd`) | `fixtures/small.otlp.json`, `fixtures/metrics.otlp.json` |

Regenerating (only if a fixture must change, for example the manifest schema gained a required field):

```sh
git worktree add <tmp>/fmt-<n> <sha>
cd <tmp>/fmt-<n> && mise run setup && mise run build
node dist/cli/main.js convert fixtures/small.otlp.json fixtures/metrics.otlp.json -o <tmp>/fmt-<n>-report --title "format <n> fixture"
cp -R <tmp>/fmt-<n>-report/data <repo>/fixtures/reports/format-<n>/
git worktree remove --force <tmp>/fmt-<n>
```

Format 3 needs no frozen copy: the end-to-end and writer tests exercise the current build.
