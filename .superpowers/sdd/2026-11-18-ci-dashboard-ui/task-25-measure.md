# Task 25 step 3: measure:live on the live-data rebuild (14 ms per request, Chromium, cold, 3 runs)

Branch feat/cicd-widgets, live report downloaded 2026-11-18 (288 files), merged with --config .github/otel-html-ci.yaml.

format 8: widget_traces 0 bytes, spans 147716242 bytes, 0.000 %
cicd 272942 bytes, spans 147716242 bytes, 0.185 %; 32 of 32 partitions carry cicd: true

| page | requests | spans.parquet | settled ms |
| --- | --- | --- | --- |
| root | 207 (207-207) | 26 (26-26) | 3186 (3173-3209) |
| ci | 207 (207-207) | 26 (26-26) | 3215 (3192-3222) |
| ci job=check | 207 (207-207) | 26 (26-26) | 3200 (3180-3223) |
| traces list | 96 (96-96) | 3 (3-3) | 1506 (1487-1510) |
| logs | 97 (97-97) | 3 (3-3) | 1632 (1620-1643) |
| trace open | 140 (140-140) | 13 (13-13) | 2420 (2409-2430) |

slider drag on #/dashboards/ci (2000 ms, 3 fresh contexts): 10.4 fps median, range 10.4-10.6

## Against targets

- CI dashboard settled <= 3.0 s, <= 100 requests: MISSED (3.2 s, 207 requests).
- Slider drag >= 30 fps: MISSED (10.4 fps).
- cicd bytes <= 1 % of spans: MET (0.185 %).

## Against the previous record

Memory note: live dashboard 185 requests / 2.9 s (plan 2026-11-16: <= 170 requests, 0 spans.parquet reads).
Now 207 / 3.2 s with 26 spans.parquet reads: worse by 22 requests and 0.3 s. The plan has no table for the other pages
(only "no worse than baseline"), so no numbers to compare for traces list, logs and trace open.
