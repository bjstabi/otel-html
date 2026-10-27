import type { JSX } from 'react';
import type { Manifest } from '../../format/manifest.js';
import type { Signal } from '../../format/paths.js';
import { PageChrome } from './page-chrome.js';

const CARD = 'rounded-card border border-hairline bg-surface p-6 max-w-xl';

const LATER: Record<'metrics' | 'dashboards', { title: string; signal: Signal; noun: string }> = {
  metrics: { title: 'Metrics', signal: 'metrics', noun: 'Metric data points in this run' },
  dashboards: { title: 'Dashboards', signal: 'spans', noun: 'Spans in this run' },
};

export function ComingLaterPage(props: { page: keyof typeof LATER; manifest: Manifest }): JSX.Element {
  const { title, signal, noun } = LATER[props.page];
  const count = props.manifest.totals[signal];
  return (
    <PageChrome title={title} signal="span" manifest={props.manifest}>
      <section className={CARD}>
        <h2 className="text-base font-semibold">Coming in a later release</h2>
        <p className="mt-1 text-sm text-ink-2">
          The {title} view is not part of this release. The data is already in the report:
        </p>
        <p className="mt-3 text-sm text-muted">{noun}</p>
        <output aria-label={noun} className="font-mono text-3xl tabular-nums text-ink">
          {count}
        </output>
      </section>
    </PageChrome>
  );
}

export function NotFoundPage({ route }: { route: string }): JSX.Element {
  return (
    <main className="p-8">
      <section className={CARD}>
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="mt-1 text-sm text-ink-2">
          No page at <code className="font-mono">{route}</code>. Use the sidebar to open a page.
        </p>
      </section>
    </main>
  );
}
