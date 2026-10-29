# otel-html M4: Dashboards design

Date: 2026-10-28 · Status: draft for approval

Builds on the main design, [`2026-10-25-otel-html-design.md`](2026-10-25-otel-html-design.md) (§8.2, §8.3, §8.6, §8.7, §9, §11.1, §16), and mockup [`05-dashboards-fusion.html`](2026-10-25-otel-html-mockups/05-dashboards-fusion.html). Everything there still holds unless this document narrows it. The M1–M3 plans set the conventions (`docs/superpowers/plans/`).

## 1. Intent

M4 adds the page that links all three signals: **Dashboards**, starting with the built-in **Fusion** dashboard. It also adds the dashboard config that teams write once and reuse on every run, and the pieces the earlier milestones deferred to M4: **Views ▾**, and **Copy as dashboard widget** from the explorers. After M4, a report opens on a single page where a time range or a trace picked in one place filters everything else, and a team can ship its own dashboards in `otel-html.yaml`.

Today the sidebar's Dashboards entry and `g d` lead to a placeholder (`src/viewer/shell/pages.tsx`), the query bar's `+ Query` button is disabled with "second query arrives with Dashboards", and the config has no `dashboards` or `views`.

## 2. Goals, non-goals, anti-goals

**Goals**
- Dashboards list (mockup screen 1) and a dashboard page (screen 2). Fusion is built in and is the default.
- A dashboard schema in the one config schema (§9, §11.1). The built-in Fusion is itself a document in that schema.
- The widget types settled in §16: `timeline`, `traces`, `logs`, `metric` (lines/area/bars/heatmap), `toplist` and `table`.
- **Variables**, **selection chips** (time, trace_id), a per-widget **⛓ follows selection** toggle, the Logs widget's **Only matches / Show context** toggle, and **Edit layout → Copy config**.
- Validation at write time, so a broken dashboard fails `convert`, not the viewer (§16).
- **Views ▾**: saved views from config, plus views saved in this browser (§8.2).
- **Copy as dashboard widget** from the Traces, Logs and Metrics explorers (§8.6, deferred from M3).

**Non-goals (M4)**
- The `+ Query` second query in the explorers' query bar. It stays disabled, and its hint changes to "not available yet". Dashboards get several queries through several widgets.
- Treemap, pie and point-plot widgets (§16: explorer views only).
- Persisting layout edits in the report or in `localStorage`. The URL and Copy config are the only way out (§2 non-goal).
- Receiver and live mode (M5).

**Anti-goals**
- A widget that re-implements an explorer component (the §8.3 reuse rule). Every widget is the shared Trace list, Flame graph, Log list, Chart card, Metric grid, Histogram/Timeline, facet chart or group table, fed by the same query engines.
- A dashboard query language of our own. Widget filters are OTTL, and metric widgets use the M3 query shape unchanged.
- Silently wrong widgets. A variable the timeline's metric lane cannot apply, a metric the report does not hold, a partial scan above budget, and a selection outside the time range each show a note.

## 3. Constraints

- Every rule from the main spec §11.1 and the M1–M3 Global Constraints.
- One new runtime dependency, **react-grid-layout 2** (named in §10). The viewer also starts bundling `yaml` (already a runtime dependency on the Node side) for Copy config.
- No `formatVersion` bump. The manifest's `config` gains defaulted fields, so M1–M3 reports still parse and merge.

## 4. Approaches (decided: 1)

1. **Dashboards travel in the manifest; the viewer computes every widget live (chosen).** The writer validates the resolved dashboards and writes them into `manifest.config` with their source. Fusion ships inside the viewer as a constant validated by the same schema. Widgets run the existing span, log and metric query engines. This matches §16 ("nothing is pre-rendered per widget").
2. **A separate `data/dashboards.js`.** Keeps the manifest small, but adds a file and a load step for a few KB of config.
3. **Pre-rendered widget data.** Faster first paint on huge reports, but contradicts §16 and doubles the query code.

## 5. Config

### 5.1 Schema (`dashboards[]`, `views[]`, two viewer keys)
- `dashboards[]`: `{ id, title, description?, variables?, widgets }`.
  - `id` matches `^[a-z0-9][a-z0-9-]{0,63}$`, is unique, and is never `fusion` (reserved).
  - `variables` (≤ 8, unique keys): a resource attribute key as a string, or `{ key, label?, default? }`.
  - `widgets` (1–50): common fields `{ id?, type, title?, x, y, w, h }` on a 12-column grid, with `0 ≤ x`, `1 ≤ w`, `x + w ≤ 12`, `y ≥ 0` and `2 ≤ h ≤ 40`. Widgets may not overlap. `id` defaults to `w1`, `w2`, … by position. Every type except `timeline` has `follow` (default `true`).
- Per type:
  - `timeline`: no other fields.
  - `traces`: `query?` (OTTL, span context), `text?`, `mode?` (`traces` | `spans`, default `traces`).
  - `logs`: `query?` (OTTL, log_record context), `text?`, `context?` (default `false`, which means Only matches).
  - `metric`: `queries?` (1–10, the M3 query shape with `metric` and `show` required), `formulas?` (the M3 formula shape; only together with `queries`), `display?` (`lines` | `area` | `bars` | `heatmap`), `scale?`, `exemplars?` (default `true`), `echarts?`. A `metric` widget without `queries` is a **resource metric grid**: the embedded Metrics grid (M3 §6.4) over the selected trace's resources, or over every resource when no trace is selected.
  - `toplist` and `table`: `signal` (`spans` | `logs`), `query?` (OTTL in that signal's context), `text?`, `groupBy` (a facet key, as in the explorers' Group by). `toplist` also takes `echarts?`.
- `echarts?` is an object merged over the chart option we build (objects merge, arrays and scalars replace). Its compatibility is ECharts', not ours, and the JSON Schema description says so (§9).
- `views[]`: `{ id, title, page, query?, text?, mode?, groupBy?, view?, sort?, metrics? }`, where `page` is `traces`, `logs` or `metrics`. `mode` and `view` must be ones that page offers (`PAGE_OPTIONS`), `query` must compile in the page's context, and `metrics` is the M3 page state, valid only on `metrics`.
- `viewer.defaultDashboard` (default `fusion`; must name a dashboard) and `viewer.home` (`traces` | `logs` | `metrics` | `dashboards`, default `traces`). `home` is where `#/` lands: `dashboards` opens the default dashboard.

### 5.2 Validation, sources, append and merge
- Validation happens when config resolves (before any input is read), with Zod issues at their path, e.g. `dashboards[0].widgets[2].query: an OTTL condition valid for spans (…)`. Metric names and attribute keys are **not** checked against the data, because one dashboard serves many reports.
- Each resolved dashboard carries a `source`: the config file's name when it came from a file, or `library API` for an object passed to `convert`/`Report.create`. Fusion's source is `built-in`.
- Precedence follows the existing leaf rule: an array is one leaf, so `dashboards` from a higher layer replaces the whole list.
- **Append:** a session whose config has no `dashboards` (or `views`) keeps the previous session's, the way `title` does today. A config that has them replaces them.
- **Merge:** `merge --config` dashboards win. Without them, the first input report's are kept (the same rule as `title`).

## 6. Viewer

### 6.1 Routes, navigation and URL
- `#/dashboards` is the list. `#/dashboards/<id>` is a dashboard. `g d` and the sidebar's starred item open the default dashboard, and the sidebar also gets "All dashboards". An unknown id shows a not-found card that links to the list.
- Dashboard state lives in one URL key, `d` (JSON, validated like `m`): `{ vars, sel: { t, trace }, follow, logView }`. `vars` maps a variable key to a value, or to `null` for "all" when the config sets a default. `follow` and `logView` hold per-widget overrides of the config. Opening another dashboard from the list, the switcher or the sidebar clears `d`.
- The page's time range is the shared `t`. The **selection window** `sel.t` is separate: brushing the timeline or dragging across a chart sets it as a chip, and the time-range control does not move. (This matches the mockup, where "Entire run" and a selection chip are shown together.)
- Carry-over: going *to* a dashboard carries `t` only. A widget's **Open in … →** goes to the matching explorer with the widget's effective filter as `q` (its query, the variables and the followed trace, each joined with `and`) and its effective window as `t`. The metric widget opens the Metrics Explorer with its queries, whose `where` includes the variables.

### 6.2 Effective scope (a data table)
| Widget | Window when following | Followed trace | Not following |
|---|---|---|---|
| timeline | the page's `t`; draws `sel.t` as the brush | – | – |
| traces | `sel.t ∩ t` | highlights the row, shows its flame graph below the list | `t` |
| logs | `sel.t ∩ t` | adds `trace_id.string == "…"`; header "N for the selected trace" | `t` |
| metric | x-range `t`, `sel.t` marked as a band | filters to the trace's resources, highlights its exemplars | `t`, no band |
| toplist / table | `sel.t ∩ t` | adds `trace_id.string == "…"` | `t` |

Variables always apply: `resource.attributes["k"] == "v"` (typed by the facet's value kind), joined with `and` to every widget's condition and to the metric queries' `where`. The timeline's span and log lanes are queried with the variables applied. Its metric-point lane comes from the unfiltered rollup and says "all resources" when a variable is set.

### 6.3 The page
- Header: the title, a **Dashboards ▾** switcher, **Edit layout**, **Copy link**, **Copy config** and the time range. There is no query bar.
- Filter bar: one dropdown per variable. The values come from the span and log Resource facets and the metric catalog's resources; "(more values not listed)" appears when a facet was capped. A variable with no values in this report is hidden, and the bar says how many were hidden.
- Selection chips: `time ∈ 14:08:50 – 14:09:40 ✕`, `trace_id = 9f3a…c1 ✕`, and **Clear all**.
- Grid: react-grid-layout with 12 columns, 20 px rows and 10 px gaps. Below 768 px, widgets stack in (y, x) order and Edit layout is disabled.
- Widget frame: drag handle ⠿ (in edit mode), title and subtitle, **⛓ follows selection** (not on the timeline), **Open in … →**, and a resize grip in edit mode.
- Copy config copies YAML of the dashboard with its current layout, leaving out fields that are at their defaults. Copying Fusion produces `id: fusion-copy` and `title: Fusion (copy)`, so the text pastes into a config without hitting the reserved id. The clipboard fallback is the Copy link dialog. Reset layout restores the config's layout.
- The trace and log panels open over the dashboard as they do over the explorers: "open trace panel →" in the Traces widget, and a row click in the Logs widget.

### 6.4 Widgets
- **Timeline:** one ECharts instance with three grids on a shared x-axis (as in the §12 spike): spans by status (errors hatched), logs by severity, and metric points. Lane labels show their totals. Dragging sets `sel.t`.
- **Traces:** the shared results table with the explorers' columns, in trace or span mode. A row click sets `sel.trace`. Below the list sits the shared Flame graph in a compact form (no minimap or legend) for the selected trace, with "open trace panel →".
- **Logs:** the shared Log list. **Show context** lists every log in the window (variables still apply) and highlights the rows that match.
- **Metric:** with `queries`, the shared chart card with the M3 query engine, the selection band, and the click menu gaining "Select this trace". A drag sets `sel.t`. Without `queries`, the M3 Metric grid with the band and the trace's exemplars highlighted.
- **Top list / Table:** the explorers' top-list chart and group table over the query result's facets.
- Every widget shows the M1–M3 loading, empty, partial ("from N of M chunks") and error states inside its frame. A widget that fails does not take the page down.

### 6.5 Fusion
`{ id: fusion, title: Fusion, variables: [service.name, deployment.environment.name, host.name] }` with widgets `timeline` (0,0,12,6), `traces` (0,6,7,13), `logs` (7,6,5,13) and a resource metric grid `metric` (0,19,12,10).

### 6.6 Views ▾ and Copy as dashboard widget
- **Views ▾** sits in the explorers' header (Traces, Logs, Metrics). It lists the config views for that page and the views saved in this browser (`localStorage`, optional, as everywhere else). It also offers "Save current view…" and a delete action on browser views. Applying a view replaces the page's state but keeps `t`.
- **Copy as dashboard widget** is an Export menu item. It maps the Traces and Logs List views to `traces`/`logs` widgets, Top list and Table to `toplist`/`table`, and the Metrics page to a `metric` widget. Other views, Patterns mode and the Distribution display explain why they cannot become widgets. It copies YAML for one widget at `x: 0, y: 0` with the type's default size.

## 7. Tests, fixtures, targets
- **Fixtures:** `fixtures/dashboards.otel-html.yaml` with one dashboard per widget type over the `linked-*` and `metrics` fixtures, a variable with a default, and a hostile title and description (`</script>`, U+2028).
- **Unit:** schema rules (overlap, bounds, reserved id, contexts, views against page options), source labels, append and merge rules, the `d` URL key, effective scope, variable conditions with quoting, Copy config round-trip, and the widget mapping.
- **e2e:** the list; Fusion brush → chip → widgets follow; trace click → Logs and Metrics follow; a variable; the follow toggle; Show context; edit layout → Copy config holds the new position; a config dashboard; Views ▾; Copy as widget; `file://` and the static server.
- **Targets** (ubuntu-latest, `OTEL_HTML_PERF_FACTOR` as before): Fusion is interactive in < 3 s on the 100k-span / 1M-log scale report, and selecting a trace updates the Logs and Metrics widgets in < 1 s.

## 8. Designer's calls (flag if wrong)
- Dashboards travel in `manifest.config`, not in their own file (§4).
- No dashboard include files (the mockup's `dashboards/tests.yaml` source). The source is the config file's name or `library API`. Includes can come later without breaking the schema.
- The selection window is separate from the page time range (§6.1).
- A `metric` widget without `queries` is the resource grid, so Fusion works on any report without naming metrics.
- `fusion` is reserved, and Copy config renames a copy of Fusion.
- Layout edits are not persisted (not even in `localStorage`). Copy config is the way to keep them.
- `viewer.home` stays `traces` by default, so existing reports land where they do today.
- `+ Query` stays disabled in M4.
- Views ▾ and Copy as dashboard widget are in M4 (deferred here by M3). They are the last viewer tasks and can be cut without touching the rest.
- Free `text` is allowed on the traces, logs, toplist and table widgets, so a copied explorer view keeps its search.

## 9. Left to the builder
Exact react-grid-layout API usage, widget subtitle wording, chip time formatting (reuse the existing formatters), default widget sizes for Copy as widget, the YAML key order in Copy config, and the plan's task order.
