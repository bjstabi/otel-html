import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { DashboardSchema } from '../../src/dashboards/schema.js';
import { WidgetFrame } from '../../src/viewer/dashboards/widget-frame.js';

afterEach(cleanup);

const widget = DashboardSchema.parse({
  id: 'd',
  title: 'D',
  widgets: [{ type: 'logs', x: 0, y: 0, w: 6, h: 6 }],
}).widgets[0];

test('the header shows a filled chip, an "ignores" chip and the fixed scope', () => {
  if (widget === undefined) throw new Error('no widget');
  render(
    <WidgetFrame
      resetKey="k"
      widget={widget}
      subtitle="s"
      following={null}
      onFollow={() => undefined}
      openIn={null}
      editing={false}
      echo={{ honoured: ['job = check'], ignored: ['run'], scope: 'last 30 runs' }}
    >
      <div />
    </WidgetFrame>,
  );
  expect(screen.getByText('job = check')).toBeTruthy();
  expect(screen.getByText('ignores run')).toBeTruthy();
  expect(screen.getByText('last 30 runs')).toBeTruthy();
});
