import { describe, expect, test } from 'vitest';
import { availableTabs, isTraceTabId, TRACE_TAB_IDS, TRACE_TABS } from '../../src/viewer/traces/tabs.js';
import { detailOf, traceRow } from './trace-rows.js';

describe('TRACE_TABS', () => {
  test('lists the tabs in order; the logs id parses but the tab is not available yet', () => {
    expect(TRACE_TABS.map((t) => t.id)).toEqual([
      'flame',
      'waterfall',
      'spans',
      'services',
      'errors',
      'logs',
    ]);
    expect(TRACE_TAB_IDS).toEqual(TRACE_TABS.map((t) => t.id));
  });

  test('errors is hidden for an error-free trace', () => {
    const d = detailOf([traceRow(1, null, 0, 10), traceRow(2, 1, 1, 2)]);
    expect(availableTabs(d).map((t) => t.id)).toEqual(['flame', 'waterfall', 'spans', 'services']);
  });

  test('errors shows for an error status or for an exception event', () => {
    expect(availableTabs(detailOf([traceRow(1, null, 0, 10, { error: true })])).map((t) => t.id)).toContain(
      'errors',
    );
    expect(
      availableTabs(detailOf([traceRow(1, null, 0, 10, { exception: true })])).map((t) => t.id),
    ).toContain('errors');
  });

  test('isTraceTabId accepts known ids only', () => {
    expect(isTraceTabId('waterfall')).toBe(true);
    expect(isTraceTabId('logs')).toBe(true);
    expect(isTraceTabId('bogus')).toBe(false);
    expect(isTraceTabId('overview')).toBe(false);
  });
});
