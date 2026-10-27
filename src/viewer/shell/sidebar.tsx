import { BarChart3, LayoutDashboard, Moon, ScrollText, Sun, SunMoon, Waypoints } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import type { Manifest } from '../../format/manifest.js';
import { carryTo } from '../state/carry.js';
import { type Page, pageOfRoute } from '../state/page-options.js';
import type { SelectionMode } from '../state/selection.js';
import { useSelection } from '../state/selection-context.js';
import { serializeUrlState } from '../state/url-state.js';
import { type ThemePreference, useTheme } from '../theme/theme-provider.js';
import { useGoTo } from './go-to.js';
import { RunCard } from './run-card.js';
import { Tip } from './tip.js';
import { routeHref, useRoute } from './use-route.js';

interface NavTarget {
  page: Page;
  route: string;
  /**
   * Set when the item is a mode of another route (Patterns is `/logs` in patterns mode): it is current there,
   * and the plain item for that route is not.
   */
  currentAt?: { route: string; mode: SelectionMode };
}
interface NavItem {
  label: string;
  /** Items without a target are announced as coming later, never rendered as dead links. */
  target: NavTarget | null;
}
interface NavSection {
  title: string;
  icon: ReactNode;
  /** Set when the section heading itself is the destination. */
  target: NavTarget | null;
  items: readonly NavItem[];
}

const ICON = { size: 16, 'aria-hidden': true } as const;

const SECTIONS: readonly NavSection[] = [
  {
    title: 'Dashboards',
    icon: <LayoutDashboard {...ICON} />,
    target: { page: 'dashboards', route: '/dashboards' },
    items: [],
  },
  {
    title: 'Logs',
    icon: <ScrollText {...ICON} />,
    target: null,
    items: [
      { label: 'Explorer', target: { page: 'logs', route: '/logs' } },
      {
        label: 'Patterns',
        target: { page: 'logs', route: '/logs/patterns', currentAt: { route: '/logs', mode: 'patterns' } },
      },
    ],
  },
  {
    title: 'Metrics',
    icon: <BarChart3 {...ICON} />,
    target: null,
    items: [
      { label: 'Explorer', target: { page: 'metrics', route: '/metrics' } },
      { label: 'Catalog', target: null },
    ],
  },
  {
    title: 'Traces',
    icon: <Waypoints {...ICON} />,
    target: null,
    items: [
      { label: 'Explorer', target: { page: 'traces', route: '/traces' } },
      { label: 'Services', target: { page: 'traces', route: '/traces/services' } },
    ],
  },
];

const TARGETS: readonly NavTarget[] = SECTIONS.flatMap((s) => [
  ...(s.target === null ? [] : [s.target]),
  ...s.items.flatMap((i) => (i.target === null ? [] : [i.target])),
]);

/** Exactly one target is current: a `currentAt` match wins over the plain item for the same route. */
function isCurrent(t: NavTarget, route: string, mode: SelectionMode | null): boolean {
  const at = (x: NavTarget): boolean => x.currentAt?.route === route && x.currentAt.mode === mode;
  if (t.currentAt !== undefined) return at(t);
  return t.route === route && !TARGETS.some(at);
}

const ROW = 'flex items-center gap-2 rounded-full px-3 py-1.5 text-sm';
const SELECTED = 'bg-ink text-page font-medium';
const IDLE = 'text-ink-2 hover:bg-hairline';

function NavLink(props: { target: NavTarget; current: string; children: ReactNode }): JSX.Element {
  const { target, current } = props;
  const selected = useSelection((s) => isCurrent(target, current, s.mode));
  const search = useSelection((s) => serializeUrlState(carryTo(s, pageOfRoute(current), target.page).url));
  const goTo = useGoTo();
  return (
    <a
      href={`${routeHref(target.route)}${search === '' ? '' : `?${search}`}`}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        goTo(target.page, target.route);
      }}
      className={`${ROW} ${selected ? SELECTED : IDLE}`}
      aria-current={selected ? 'page' : undefined}
      data-selected={selected ? 'true' : undefined}
    >
      {props.children}
    </a>
  );
}

const THEMES: readonly { value: ThemePreference; label: string; icon: ReactNode }[] = [
  { value: 'system', label: 'System theme', icon: <SunMoon size={16} aria-hidden /> },
  { value: 'light', label: 'Light theme', icon: <Sun size={16} aria-hidden /> },
  { value: 'dark', label: 'Dark theme', icon: <Moon size={16} aria-hidden /> },
];

function ThemeToggle(): JSX.Element {
  const { preference, setPreference } = useTheme();
  return (
    <fieldset className="flex gap-1">
      <legend className="sr-only">Theme</legend>
      {THEMES.map((t) => (
        <Tip key={t.value} label={t.label}>
          <button
            type="button"
            aria-label={t.label}
            aria-pressed={preference === t.value}
            onClick={() => setPreference(t.value)}
            className={`rounded-full p-2 ${preference === t.value ? SELECTED : IDLE}`}
          >
            {t.icon}
          </button>
        </Tip>
      ))}
    </fieldset>
  );
}

export function Sidebar({ manifest }: { manifest: Manifest }): JSX.Element {
  const [current] = useRoute();
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-4 border-r border-hairline p-3">
      <RunCard manifest={manifest} />
      <nav aria-label="Primary" className="flex flex-1 flex-col gap-3">
        {SECTIONS.map((s) => (
          <section key={s.title} aria-labelledby={`nav-${s.title}`} className="flex flex-col gap-0.5">
            <h2
              id={`nav-${s.title}`}
              className={
                s.target === null ? 'text-xs font-semibold uppercase tracking-wide text-muted' : 'text-sm'
              }
            >
              {s.target === null ? (
                <span className="flex items-center gap-2 px-3 py-1">
                  {s.icon}
                  {s.title}
                </span>
              ) : (
                <NavLink target={s.target} current={current}>
                  {s.icon}
                  {s.title}
                </NavLink>
              )}
            </h2>
            {s.items.map((item) =>
              item.target === null ? (
                <span key={item.label} aria-disabled="true" className={`${ROW} ml-4 text-muted`}>
                  <span>{item.label}</span>
                  <span className="text-xs">Soon</span>
                </span>
              ) : (
                <div key={item.label} className="ml-4 flex flex-col">
                  <NavLink target={item.target} current={current}>
                    {item.label}
                  </NavLink>
                </div>
              ),
            )}
          </section>
        ))}
      </nav>
      <ThemeToggle />
    </aside>
  );
}
