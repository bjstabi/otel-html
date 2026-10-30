/**
 * Ids and names shared by the fixture generator (`scripts/fixtures.ts`), which writes them into `fixtures/*.otlp.json`,
 * and the e2e specs that look for them (re-exported by `e2e/fixture.ts`).
 */
export const LINKED_TRACE = '5134a3f57d52d9e9822e617916d38b35';
/** `payments.Charge` in `LINKED_TRACE`: 7 logs, among them 3 declined-card and 3 retry lines. */
export const LINKED_SPAN = '1d8745a159cef356';
export const METRIC_HIST = 'http.server.request.duration';
/** The trace id of the one exemplar on `METRIC_HIST` that points at a trace absent from the traces file. */
export const ORPHAN_EXEMPLAR_TRACE = '9c1f0e5ab27d4c3388e0f6a1b5d2c47e';
export const HOSTILE_METRIC_NAME = '</script><img src=x onerror=alert(1)>';
/** The hostile metric's unit and the value of its one attribute, `HOSTILE_METRIC_ATTR`: markup that reaches the tooltip. */
export const HOSTILE_METRIC_UNIT = '<img src=x onerror=alert(1)>';
export const HOSTILE_METRIC_ATTR = 'hostile.attr';
export const HOSTILE_METRIC_ATTR_VALUE = '"><img src=x onerror=alert(1)>';
