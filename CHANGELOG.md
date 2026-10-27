# Changelog

## [0.1.1](https://github.com/bjstabi/otel-html/compare/otel-html-v0.1.0...otel-html-v0.1.1) (2026-10-27)


### Bug fixes

* **build:** run bash-syntax mise tasks under bash on every OS ([b4eb6a6](https://github.com/bjstabi/otel-html/commit/b4eb6a668127310ed2afdca048140badaa608b09))

## 0.1.0 (2026-10-27)


### Features

* **api:** Report, convert and merge with append-by-reopen ([1c1e3d4](https://github.com/bjstabi/otel-html/commit/1c1e3d4f476a9aacd8656351ff22b196899f9308))
* **cli:** convert, merge and config print ([0a77b7c](https://github.com/bjstabi/otel-html/commit/0a77b7cc70ae2f0500091a17baf7de7fb14eb56c))
* **config:** one Zod schema with layered resolution and JSON Schema ([efee9e4](https://github.com/bjstabi/otel-html/commit/efee9e46adb3e6408046ce57181b4db6241b0f0c))
* **format:** classic-script data files, declarative column codec, manifest ([1b83faa](https://github.com/bjstabi/otel-html/commit/1b83faad7260c4eedda160cff6012f44f671c1c8))
* **model:** branded ids and times, typed errors, fs/clock ports ([d7aa765](https://github.com/bjstabi/otel-html/commit/d7aa765bbbe7a12f3f9ff2f86aeb12d708c7c2f3))
* **model:** generated OTLP types and normalized records ([cca6eb5](https://github.com/bjstabi/otel-html/commit/cca6eb5e9d9efe579f8e959b286680fb9c835e1e))
* **model:** map SDK ReadableSpans to OTLP ([ca49e39](https://github.com/bjstabi/otel-html/commit/ca49e3914f346f050ccced462e87d7f699122480))
* **model:** parse OTLP JSON/protobuf/JSON-lines and normalize records ([5ff57f8](https://github.com/bjstabi/otel-html/commit/5ff57f8ef74ca8cdf158b0edb8249378329d8b49))
* otel-html M1 — static HTML reports for OpenTelemetry data ([f7e779a](https://github.com/bjstabi/otel-html/commit/f7e779a798ef2a6c3193b9c63b793e145bde5c75))
* **ottl:** Lezer grammar and parser for OTTL conditions ([18343ca](https://github.com/bjstabi/otel-html/commit/18343ca42c2010f49e4d71e37284bdbae0649cdc))
* **ottl:** typed compiler and evaluator with OTTL comparison semantics ([08d926d](https://github.com/bjstabi/otel-html/commit/08d926de9d68b0910cc25777eaa2ad6acc480539))
* **rollups:** exponential histograms, time buckets, facets, RED and semconv tables ([5c0f76a](https://github.com/bjstabi/otel-html/commit/5c0f76aadd6353d79ca9211645ccd83b5e710049))
* **viewer:** app shell with sidebar, run card, time range and shortcuts ([e9be00d](https://github.com/bjstabi/otel-html/commit/e9be00dbd21cd5da2ed27c4d95b9a7873cf77ab9))
* **viewer:** apply the report's viewer.theme setting ([97cda06](https://github.com/bjstabi/otel-html/commit/97cda0673360f1152d119e40aeced8705eef164a))
* **viewer:** classic IIFE build, data registry and file:// smoke tests ([45c812e](https://github.com/bjstabi/otel-html/commit/45c812e3255f47a461cb1697ae94c142151d9b11))
* **viewer:** DataSource with eager and windowed strategies ([f519fca](https://github.com/bjstabi/otel-html/commit/f519fca3ac8ba77d000bbd042a13a74aaaa59fa1))
* **viewer:** design tokens, validated palette and runtime ECharts themes ([f3e770a](https://github.com/bjstabi/otel-html/commit/f3e770adff274e0d5cee9ab0b278fb69622b4446))
* **viewer:** query bar with OTTL tokens, facet panel, histogram card ([5329a67](https://github.com/bjstabi/otel-html/commit/5329a671c272268726e1b1ec770fba879e16ce45))
* **viewer:** selection store with validated URL state ([bd2e861](https://github.com/bjstabi/otel-html/commit/bd2e861de18bab9a425463b274c67de27b0f2f4f))
* **viewer:** span section with semconv attribute groups, events, links and resource ([1094ed7](https://github.com/bjstabi/otel-html/commit/1094ed71595ae5453a0ff5cb8588e0117054d828))
* **viewer:** trace panel with flame graph, waterfall, span list, services and errors ([b5286ad](https://github.com/bjstabi/otel-html/commit/b5286ad903834f82a73e2c7389bf364cbec951f8))
* **viewer:** Traces explorer with views, RED strip, results table and Services page ([dcf59aa](https://github.com/bjstabi/otel-html/commit/dcf59aab6a87309c3932f63aaba122bcd21b4095))
* **writer:** streaming session with chunks, trace index, dedupe, drop, checkpoints and lock ([3ba82bf](https://github.com/bjstabi/otel-html/commit/3ba82bfa0d3849933c61df58600042d8afdafd69))


### Bug fixes

* **api:** canonical merge path guard, dist-aware viewer assets validated up front, split-trace and crash coverage ([f1e8cb9](https://github.com/bjstabi/otel-html/commit/f1e8cb9b15f111a40ae45775cfe2d4cab921dc54))
* **config:** reject prototype-polluting keys before merging layers ([12ab188](https://github.com/bjstabi/otel-html/commit/12ab18842fb8415c4e52a64cd9a05af0b4511d64))
* epoch is the earliest timestamp, strict manifest paths, unknown_service fallback, faithful memory fs ([fc99250](https://github.com/bjstabi/otel-html/commit/fc99250b2c26a1a9fbc85abdf02e6668bffc5af5))
* **model:** object-input OTLP path, explicit failure without JSON source text, collision-free scope key ([8f22d7d](https://github.com/bjstabi/otel-html/commit/8f22d7d267a68714bdc89943dc467e2444a73585))
* **ottl:** close regex class-scan ReDoS bypass and report enum columns ([e22f087](https://github.com/bjstabi/otel-html/commit/e22f0875736e4d7fb12fd5998a626e0facf27400))
* **viewer:** apply data-theme before chart effects read tokens ([87fb219](https://github.com/bjstabi/otel-html/commit/87fb21981221cf90fbf451ae98c3a30dde92b769))
* **viewer:** fail fast when data/manifest.js did not register ([a068f1a](https://github.com/bjstabi/otel-html/commit/a068f1ab48a27d12ca6314acd3308bdf5f2eb740))
* **viewer:** guard query bar edits, commit on enter/blur, scoped facet keys, full-value facet search ([ab63098](https://github.com/bjstabi/otel-html/commit/ab630982a309e699dc7600557705fde354c67aec))
* **viewer:** harden facet key mapping, require bindUrl error sink, validate setters ([d3a8c97](https://github.com/bjstabi/otel-html/commit/d3a8c97f5e607732c80a7a9acc723c53be7cb840))
* **viewer:** scope-correct event/link actions and cheap link presence check ([d8a79d6](https://github.com/bjstabi/otel-html/commit/d8a79d68855e9dc814175aae14cc1a11d677d0b7))
* **viewer:** shell step bounds, query-carrying navigation, overlay-aware shortcuts ([e750fcd](https://github.com/bjstabi/otel-html/commit/e750fcd85402ee00c32eca37c6b083d253af152d))
* **viewer:** table group-by, duration-bin caveat, partial Services page, export and a11y fixes ([9157c5b](https://github.com/bjstabi/otel-html/commit/9157c5b9e777501463a26ff9a075cb6e32ef4a64))
* **viewer:** typed facet filters for Status, Kind and numeric/boolean attributes ([2a2ec34](https://github.com/bjstabi/otel-html/commit/2a2ec349a73e4014a13dd3ff10bc179336adbf06))
* **viewer:** whole-trace figures for windowed traces mode, groupBy fails fast ([b9258f7](https://github.com/bjstabi/otel-html/commit/b9258f735822034f6ecc42dfff16b1571121735b))
* **writer:** a failed convert no longer destroys the existing report ([2bd1baa](https://github.com/bjstabi/otel-html/commit/2bd1baa24351018b8edb23f24a48c9d8bce0ee91))
* **writer:** all-or-nothing accept, derived dirtiness, lock-safe release, append precheck ([aec3084](https://github.com/bjstabi/otel-html/commit/aec3084c24c6a4d43996fac3c2675eac99900593))


### Performance

* **viewer:** cheaper chunk decoding and a top-k result sort ([828c951](https://github.com/bjstabi/otel-html/commit/828c9518dcc0ad73358928b86cfb3883151fe52f))
* **viewer:** draw the status histogram at most 300 columns wide ([0162e97](https://github.com/bjstabi/otel-html/commit/0162e973818ab29504401e061cd8e444d8f82d1a))
* **viewer:** skip the no-op resize render and catch the first render's events ([00fbf8e](https://github.com/bjstabi/otel-html/commit/00fbf8ea632bae198e71a2f0b45c59fda0412219))


### Documentation

* add M1 implementation plan ([bfe1c7b](https://github.com/bjstabi/otel-html/commit/bfe1c7b97550432f1c024d52d4bee7a9cbf317e2))
* add otel-html design spec and mockups ([38fc3db](https://github.com/bjstabi/otel-html/commit/38fc3db64111641047433002c45e4ea456cffcb3))
* README fixes for merge versions, checksum command and viewer.theme ([9df0b1a](https://github.com/bjstabi/otel-html/commit/9df0b1a3c6884f0775279d053fd3a89e92f9e3b2))
* README for M1 ([7b1e2c5](https://github.com/bjstabi/otel-html/commit/7b1e2c5122b7e0ff30621fbbfff0799e0d2b2869))


### Chores

* release 0.1.0 ([cc1bd4d](https://github.com/bjstabi/otel-html/commit/cc1bd4dfb5d4d5bc7be62d5cc55cfb31f9cf159a))
