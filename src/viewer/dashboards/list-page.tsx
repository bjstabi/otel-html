import { Search, Star } from 'lucide-react';
import { type JSX, type ReactNode, useMemo, useState } from 'react';
import type { Manifest } from '../../format/manifest.js';
import { useGoTo } from '../shell/go-to.js';
import { PageChrome } from '../shell/page-chrome.js';
import { routeHref } from '../shell/use-route.js';
import { type DashboardEntry, dashboardsOf } from './registry.js';

const TH = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted';
const TD = 'px-3 py-2 align-top';

/** A link to the list or a dashboard; it drops the previous dashboard's `d` state. */
export function DashboardLink(props: { to: string; className?: string; children: ReactNode }): JSX.Element {
  const goTo = useGoTo();
  const route = props.to;
  return (
    <a
      href={routeHref(route)}
      {...(props.className === undefined ? {} : { className: props.className })}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        goTo('dashboards', route, { d: null });
      }}
    >
      {props.children}
    </a>
  );
}

function matches(e: DashboardEntry, needle: string): boolean {
  const { title, description } = e.dashboard;
  return `${title}\n${description}`.toLowerCase().includes(needle);
}

/** Every dashboard in the report: Fusion first, then the configured ones, filterable by name or description. */
export function DashboardsListPage(props: { manifest: Manifest }): JSX.Element {
  const entries = useMemo(() => dashboardsOf(props.manifest), [props.manifest]);
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const rows = needle === '' ? entries : entries.filter((e) => matches(e, needle));
  return (
    <PageChrome title="Dashboards" manifest={props.manifest}>
      <div className="flex flex-col gap-3">
        <label className="flex max-w-sm items-center gap-2 rounded-full border border-hairline bg-surface px-3 py-1.5">
          <Search size={16} aria-hidden className="text-muted" />
          <input
            type="search"
            aria-label="Filter dashboards"
            placeholder="Filter dashboards"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
        <table className="w-full max-w-5xl rounded-card border border-hairline bg-surface text-sm">
          <caption className="pb-2 text-left text-xs text-muted">
            {rows.length} {rows.length === 1 ? 'dashboard' : 'dashboards'}
          </caption>
          <thead>
            <tr className="border-b border-hairline">
              <th scope="col" className={TH}>
                Name
              </th>
              <th scope="col" className={TH}>
                Source
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Widgets
              </th>
              <th scope="col" className={TH}>
                Description
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.dashboard.id} className="border-b border-hairline last:border-0">
                <td className={TD}>
                  <DashboardLink
                    to={`/dashboards/${e.dashboard.id}`}
                    className="font-semibold hover:underline"
                  >
                    {e.dashboard.title}
                  </DashboardLink>
                  {e.isDefault && (
                    <Star
                      size={12}
                      aria-label="Default dashboard"
                      role="img"
                      className="ml-1.5 inline fill-current text-accent"
                    />
                  )}
                </td>
                <td className={TD}>
                  <span className="rounded-full border border-hairline px-2 py-0.5 font-mono text-xs">
                    {e.source === 'built-in' ? 'BUILT-IN' : e.source}
                  </span>
                </td>
                <td className={`${TD} text-right tabular-nums`}>{e.dashboard.widgets.length}</td>
                <td className={`${TD} text-ink-2`}>{e.dashboard.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageChrome>
  );
}
