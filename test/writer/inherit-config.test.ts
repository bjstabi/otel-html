import { describe, expect, test } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.js';
import { inheritDashboards } from '../../src/writer/inherit-config.js';

const prior = (defaultWindow?: string) => ({
  dashboards: [],
  views: [],
  viewer: {
    defaultDashboard: 'fusion',
    home: 'traces' as const,
    ...(defaultWindow === undefined ? {} : { defaultWindow }),
  },
});

describe('inheritDashboards and viewer.defaultWindow', () => {
  test('a run without a config keeps the prior report’s default window', () => {
    const { config } = resolveConfig({ env: {} });
    expect(inheritDashboards(config, prior('7d')).viewer.defaultWindow).toBe('7d');
  });

  test('a config that sets one replaces it', () => {
    const { config } = resolveConfig({ file: { viewer: { defaultWindow: '6h' } }, env: {} });
    expect(inheritDashboards(config, prior('7d')).viewer.defaultWindow).toBe('6h');
  });

  test('neither sets one: none', () => {
    const { config } = resolveConfig({ env: {} });
    expect(inheritDashboards(config, prior()).viewer.defaultWindow).toBeUndefined();
  });
});
