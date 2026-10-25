import { describe, expect, it } from 'vitest';
import { buildEchartsTheme } from '../../src/viewer/theme/echarts-theme.js';

const tokens: Record<string, string> = {
  '--oh-series-1': '#2a78d6',
  '--oh-series-2': '#eb6834',
  '--oh-ink': '#16181d',
  '--oh-muted': '#6b7280',
  '--oh-hairline': '#e5e5e0',
  '--oh-surface': '#ffffff',
  '--oh-font-mono': 'monospace',
};

describe('buildEchartsTheme', () => {
  it('maps series tokens to the colour list and sets 2px lines', () => {
    const theme = buildEchartsTheme(tokens) as {
      color: string[];
      line: { lineStyle: { width: number } };
    };
    expect(theme.color[0]).toBe('#2a78d6');
    expect(theme.color[1]).toBe('#eb6834');
    expect(theme.line.lineStyle.width).toBe(2);
  });
});
