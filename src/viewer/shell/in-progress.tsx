import { createContext, type JSX, useContext, useEffect, useState } from 'react';
import { CONTROL } from './controls.js';

const POLL_KEY = 'otel-html.poll';
export const POLL_MS = 60_000;
const AGE_TICK_MS = 30_000;

/** The viewer's Refresh (D55): what the in-progress line and a gone-file alert call. `refresh` never rejects; a failure lands in `error`. */
export interface RefreshControl {
  refresh: () => void;
  busy: boolean;
  /** The message of the last refresh that failed; null after a refresh succeeds. */
  error: string | null;
  /** Auto-refresh: `App` owns the timer, so it runs on every page and navigation does not restart it. */
  poll: boolean;
  setPoll: (on: boolean) => void;
}

/** Null where there is nothing to refresh: a served report (the host serves one manifest) and the tests that mount a page alone. */
export const RefreshContext = createContext<RefreshControl | null>(null);

export function useRefreshControl(): RefreshControl | null {
  return useContext(RefreshContext);
}

export function readPoll(): boolean {
  try {
    return window.sessionStorage.getItem(POLL_KEY) === '1';
  } catch {
    return false;
  }
}

export function writePoll(on: boolean): void {
  try {
    window.sessionStorage.setItem(POLL_KEY, on ? '1' : '0');
  } catch {
    // Storage is a per-tab convenience; without it the choice lasts until the page closes.
  }
}

function ageText(updatedAt: string, now: number): string {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return 'updated at an unknown time';
  const min = Math.max(0, Math.floor((now - then) / 60_000));
  if (min < 1) return 'updated just now';
  if (min < 60) return `updated ${min} min ago`;
  return `updated ${Math.floor(min / 60)} h ago`;
}

/**
 * The line under the page header while a CI run's report is still growing (`manifest.complete === false`): its age
 * (the CDN may still serve an older manifest than the last Refresh asked for, so the age says so), a Refresh button and
 * the checkbox of the opt-in 60 s poll (remembered per tab; `App` runs the timer). A served report has no `refresh`: the line shows the state only.
 */
export function InProgress(props: {
  updatedAt: string;
  complete: boolean;
  refresh: (() => void) | null;
  busy: boolean;
  error: string | null;
  poll: boolean;
  onPoll: (on: boolean) => void;
}): JSX.Element | null {
  const { complete, refresh } = props;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (complete) return;
    const t = window.setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => window.clearInterval(t);
  }, [complete]);

  if (complete) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-hairline bg-surface px-4 py-1.5 text-sm text-ink-2">
      <span role="status">{`In progress · ${ageText(props.updatedAt, now)}`}</span>
      {refresh === null ? null : (
        <>
          <button type="button" className={CONTROL} disabled={props.busy} onClick={refresh}>
            Refresh
          </button>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={props.poll}
              onChange={(e) => props.onPoll(e.currentTarget.checked)}
            />
            Auto-refresh
          </label>
        </>
      )}
      {props.error === null ? null : (
        <span role="alert" className="font-mono text-xs break-words text-critical">
          The refresh failed: {props.error}
        </span>
      )}
    </div>
  );
}

/** Under a failed query whose file the site no longer serves (D56): the report changed; Refresh re-reads the manifest. */
export function GoneNotice(): JSX.Element | null {
  const control = useRefreshControl();
  if (control === null) return null;
  return (
    <div className="mt-2 flex items-center gap-3 text-sm text-ink">
      <span>This report has changed. Refresh.</span>
      <button type="button" className={CONTROL} disabled={control.busy} onClick={control.refresh}>
        Refresh
      </button>
    </div>
  );
}
