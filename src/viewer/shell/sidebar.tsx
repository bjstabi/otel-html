import { BarChart3, LayoutDashboard, Moon, ScrollText, Sun, SunMoon, Waypoints } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { Link } from 'wouter';
import type { Manifest } from '../../format/manifest.js';
import { type ThemePreference, useTheme } from '../theme/theme-provider.js';
import { RunCard } from './run-card.js';
import { Tip } from './tip.js';
import { useRoute } from './use-route.js';

interface NavItem {
  label: string;
  /** Items without a route are announced as coming later, never rendered as dead links. */
  route: string | null;
}
interface NavSection {
  title: string;
  icon: ReactNode;
  /** Set when the section heading itself is the destination. */
  route: string | null;
  items: readonly NavItem[];
}

const ICON = { size: 16, 'aria-hidden': true } as const;

const SECTIONS: readonly NavSection[] = [
  { title: 'Dashboards', icon: <LayoutDashboard {...ICON} />, route: '/dashboards', items: [] },
  {
    title: 'Logs',
    icon: <ScrollText {...ICON} />,
    route: null,
    items: [
      { label: 'Explorer', route: '/logs' },
      { label: 'Patterns', route: null },
    ],
  },
  {
    title: 'Metrics',
    icon: <BarChart3 {...ICON} />,
    route: null,
    items: [
      { label: 'Explorer', route: '/metrics' },
      { label: 'Catalog', route: null },
    ],
  },
  {
    title: 'Traces',
    icon: <Waypoints {...ICON} />,
    route: null,
    items: [
      { label: 'Explorer', route: '/traces' },
      { label: 'Services', route: '/traces/services' },
    ],
  },
];

const ROW = 'flex items-center gap-2 rounded-full px-3 py-1.5 text-sm';
const SELECTED = 'bg-ink text-page font-medium';
const IDLE = 'text-ink-2 hover:bg-hairline';

function NavLink(props: { href: string; current: string; children: ReactNode }): JSX.Element {
  const selected = props.current === props.href;
  return (
    <Link
      href={props.href}
      className={`${ROW} ${selected ? SELECTED : IDLE}`}
      aria-current={selected ? 'page' : undefined}
      data-selected={selected ? 'true' : undefined}
    >
      {props.children}
    </Link>
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
                s.route === null ? 'text-xs font-semibold uppercase tracking-wide text-muted' : 'text-sm'
              }
            >
              {s.route === null ? (
                <span className="flex items-center gap-2 px-3 py-1">
                  {s.icon}
                  {s.title}
                </span>
              ) : (
                <NavLink href={s.route} current={current}>
                  {s.icon}
                  {s.title}
                </NavLink>
              )}
            </h2>
            {s.items.map((item) =>
              item.route === null ? (
                <span key={item.label} aria-disabled="true" className={`${ROW} ml-4 text-muted`}>
                  <span>{item.label}</span>
                  <span className="text-xs">Soon</span>
                </span>
              ) : (
                <div key={item.label} className="ml-4 flex flex-col">
                  <NavLink href={item.route} current={current}>
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
