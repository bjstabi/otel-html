import type { JSX } from 'react';

const CARD = 'rounded-card border border-hairline bg-surface p-6 max-w-xl';

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
