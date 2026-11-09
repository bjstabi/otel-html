# Frozen reports

Data folders (`data/**` only; no `assets/`, no `index.html`) written by older otel-html builds, kept byte for byte.
`test/format/compat.test.ts` merges each one with the current build and checks that its totals survive, so a change
that stops reading an older format version fails the tests. Do not regenerate or edit them. `SHA256SUMS` lists every file under `format-*/` and `test/format/frozen-checksums.test.ts` compares it with the disk both ways, so an edited, added or removed byte fails the tests.

| Folder | `formatVersion` | Written by | Inputs |
| --- | --- | --- | --- |
| `format-1/` | 1 | `68ce54f`, the last commit that writes format 1 (the plan's `1b83faa` predates the CLI) | `fixtures/small.otlp.json`, `fixtures/metrics.otlp.json` |
| `format-2/` | 2 | `01d0e53`, the first commit that writes format 2 (the last is `858f1fd`) | `fixtures/small.otlp.json`, `fixtures/metrics.otlp.json` |
| `format-3/` | 3 | `otel-html-v0.2.1` (`3e2ede4`), the last release that writes format 3 when it was frozen | `fixtures/small.otlp.json`, `fixtures/metrics.otlp.json` |
| `format-4/` | 4 | `7da10ea5` on `feat/format-4`, the head the format-4 release is cut from | `fixtures/small.otlp.json`, `fixtures/metrics.otlp.json` |

Regenerating (only if a fixture must change, for example the manifest schema gained a required field):

```sh
git worktree add <tmp>/fmt-<n> <sha or release tag>
cd <tmp>/fmt-<n> && mise run setup && mise run build
node dist/cli/main.js convert fixtures/small.otlp.json fixtures/metrics.otlp.json -o <tmp>/fmt-<n>-report --title "format <n> fixture"
cp -R <tmp>/fmt-<n>-report/data <repo>/fixtures/reports/format-<n>/
git worktree remove --force <tmp>/fmt-<n>
(cd <repo>/fixtures/reports && find format-* -type f | LC_ALL=C sort | xargs sha256sum > SHA256SUMS)
```

What is covered: `test/format/compat.test.ts` merges each fixture with the current reader and checks its manifest version and totals. `test/viewer-data/frozen-reports.test.ts` merges each fixture into a format-4 report in memory, opens it with the viewer's DuckDB data source over the Node engine, and checks the span total and one trace. `e2e/frozen.spec.ts` renders each fixture in the current viewer in a browser. `test/cli/host.test.ts` serves `format-4/` with `otel-html host` and counts its spans and points over `/query`. `test/format/frozen-checksums.test.ts` pins the bytes of every file. Not covered: reports of a format version older than the oldest fixture here, and the paged level and exemplar files format 3 introduced (`l<k>-<page>.js`, `ex-<page>.js`): these inputs are too short to fill a page, so `format-3/` holds only unpaged metric files.

The current writer writes format 4 only, so `format-4/` is what catches an in-place change to a format-4 shape (the Parquet schemas, the manifest, the `.parquet.js` wrappers): the rebuilt reports change with the writer, the frozen one does not. `format-1/` to `format-3/` hold the conversion path.

Every format version a release ships has a frozen report here, written by that release and added when the release is cut (a release that ships a format already frozen adds nothing). That also means adding it to `FROZEN` in the checksum test, `buildFrozenReports`, `ReportName`, the mounted list in `e2e/global-setup.ts` and the loop in `e2e/frozen.spec.ts`, and regenerating `SHA256SUMS`. A version leaves `READABLE_FORMAT_VERSIONS` only together with its fixture.
