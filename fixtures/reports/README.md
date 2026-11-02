# Frozen reports

Data folders (`data/**` only; no `assets/`, no `index.html`) written by older otel-html builds, kept byte for byte.
`test/format/compat.test.ts` merges each one with the current build and checks that its totals survive, so a change
that stops reading an older format version fails the tests. Do not regenerate or edit them. `SHA256SUMS` lists every file under `format-*/` and `test/format/frozen-checksums.test.ts` compares it with the disk both ways, so an edited, added or removed byte fails the tests.

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
(cd <repo>/fixtures/reports && find format-* -type f | LC_ALL=C sort | xargs sha256sum > SHA256SUMS)
```

What is covered: `test/format/compat.test.ts` merges each fixture with the current reader and checks its manifest version and totals. `test/viewer/frozen-reports.test.ts` loads each fixture from disk through the viewer's scripted loader and runs the viewer's data layer on it (manifest parse, span query, metric catalog, every metric level, and the format-1 fallback of measuring point gaps). `e2e/frozen.spec.ts` renders each fixture in the current viewer in a browser. `test/format/frozen-checksums.test.ts` pins the bytes of every file. Not covered: reports of a format version older than the oldest fixture here.

When a version is bumped, add a frozen report of the outgoing version here and to both tests. A version leaves `READABLE_FORMAT_VERSIONS` only together with its fixture.

Format 3 needs no frozen copy: the end-to-end and writer tests exercise the current build.
