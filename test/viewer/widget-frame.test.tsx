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

test('the chips clip inside their own group; the header actions never shrink', () => {
  if (widget === undefined) throw new Error('no widget');
  render(
    <WidgetFrame
      resetKey="k"
      widget={widget}
      subtitle="s"
      following={true}
      onFollow={() => undefined}
      openIn={{ label: 'Open in Logs', onOpen: () => undefined }}
      editing={false}
      echo={{
        honoured: ['job = a-very-long-job-name', 'runner = a-very-long-runner-name'],
        ignored: ['a-long-label'],
        scope: null,
      }}
    >
      <div />
    </WidgetFrame>,
  );
  const group = screen.getByTestId('echo');
  for (const cls of ['min-w-0', 'shrink', 'overflow-hidden']) expect(group.className).toContain(cls);
  for (const chip of Array.from(group.children)) expect(chip.className).toContain('shrink-0');
  expect(screen.getByRole('button', { name: /follows selection/ }).className).toContain('shrink-0');
  expect(screen.getByRole('button', { name: /Open in Logs/ }).className).toContain('shrink-0');
});

test('the follow toggle keeps its name and title and hides its words in a narrow header', () => {
  if (widget === undefined) throw new Error('no widget');
  render(
    <WidgetFrame
      resetKey="k"
      widget={widget}
      subtitle="s"
      following={true}
      onFollow={() => undefined}
      openIn={null}
      editing={false}
    >
      <div />
    </WidgetFrame>,
  );
  const toggle = screen.getByRole('button', { name: /follows selection/ });
  expect(toggle.getAttribute('title')).toBe('Follows the selection');
  const words = [...toggle.querySelectorAll('span')].find((e) => e.textContent === 'follows selection');
  expect(words?.className).toMatch(/\bhidden\b/);
  expect(words?.className).toMatch(/@\[[^\]]+\]:inline/);
  expect(toggle.closest('header')?.className).toMatch(/@container/);
});
