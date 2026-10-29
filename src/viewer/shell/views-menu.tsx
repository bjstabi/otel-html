import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { BookmarkPlus, ChevronDown, Trash2 } from 'lucide-react';
import { type FormEvent, type JSX, useState } from 'react';
import type { View } from '../../dashboards/schema.js';
import type { Manifest } from '../../format/manifest.js';
import { EXPLORER_VIEWS, type ExplorerPage, SELECTION_MODES } from '../../query/pages.js';
import { serializeUrlState, type UrlState } from '../state/url-state.js';
import { CONTROL, POPUP } from './page-chrome.js';
import { navigateRoute } from './use-route.js';

export const LOCAL_VIEWS_KEY = 'otel-html:views:v1';

/** Keys a saved view leaves out: the window (kept from the page being left) and what selects one trace, span or log. */
const NOT_SAVED = ['t', 'trace', 'span', 'log'] as const;
const PAGES: readonly ExplorerPage[] = ['traces', 'logs', 'metrics'];

export interface LocalView {
  id: string;
  title: string;
  page: ExplorerPage;
  /** The page's URL query without `t` and the trace/span/log keys. */
  search: string;
}

/** A config view as URL state; `t` is the page's current window, which a view never replaces. */
export function viewToUrl(v: View, keepT: string | undefined): UrlState {
  const url: UrlState = {};
  if (v.query !== null) url.q = v.query;
  if (v.text !== '') url.text = v.text;
  const mode = SELECTION_MODES.find((m) => m === v.mode);
  if (mode !== undefined) url.mode = mode;
  if (v.groupBy !== null) url.group = v.groupBy;
  const view = EXPLORER_VIEWS.find((x) => x === v.view);
  if (view !== undefined) url.view = view;
  if (v.sort !== null) url.sort = v.sort;
  if (v.metrics !== null) url.m = v.metrics;
  if (keepT !== undefined) url.t = keepT;
  return url;
}

function isLocalView(x: unknown): x is LocalView {
  if (typeof x !== 'object' || x === null) return false;
  return (
    typeof Reflect.get(x, 'id') === 'string' &&
    typeof Reflect.get(x, 'title') === 'string' &&
    typeof Reflect.get(x, 'search') === 'string' &&
    PAGES.some((p) => p === Reflect.get(x, 'page'))
  );
}

/** The views saved in this browser; anything unreadable (no storage, bad JSON, wrong shape) is no views. */
export function readLocalViews(storage: Pick<Storage, 'getItem'> | null): LocalView[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(LOCAL_VIEWS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLocalView) : [];
  } catch {
    return [];
  }
}

export function writeLocalViews(
  storage: Pick<Storage, 'setItem'> | null,
  views: readonly LocalView[],
): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(LOCAL_VIEWS_KEY, JSON.stringify(views));
    return true;
  } catch {
    return false;
  }
}

/** `localStorage` when it can be read, else null (blocked, private window, throwing accessors). */
function openStorage(): Storage | null {
  try {
    const s = window.localStorage;
    s.getItem(LOCAL_VIEWS_KEY);
    return s;
  } catch {
    return null;
  }
}

function currentParams(): URLSearchParams {
  const hash = window.location.hash;
  const qi = hash.indexOf('?');
  return new URLSearchParams(qi >= 0 ? hash.slice(qi + 1) : '');
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

const ITEM = 'rounded-md px-3 py-1.5 text-sm hover:bg-hairline';
const HEADING = 'px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-muted';

/** Views ▾: the config views for this page, the ones saved in this browser, and saving the current one. */
export function ViewsMenu(props: { page: ExplorerPage; manifest: Manifest }): JSX.Element {
  const { page } = props;
  const [storage] = useState(openStorage);
  const [all, setAll] = useState(() => readLocalViews(storage));
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [failed, setFailed] = useState(false);
  const configViews = props.manifest.config.views.filter((v) => v.page === page);
  const local = all.filter((v) => v.page === page);

  const apply = (search: string): void => {
    // The window stays; everything else is the view's. The raw query goes through so `bindUrl` reports a bad one.
    const params = new URLSearchParams(search);
    for (const k of NOT_SAVED) params.delete(k);
    const keepT = currentParams().get('t');
    if (keepT !== null) params.set('t', keepT);
    navigateRoute(window, `/${page}`, params.toString().replace(/%7E/g, '~'));
  };
  const applyConfig = (v: View): void => {
    const keepT = currentParams().get('t') ?? undefined;
    navigateRoute(window, `/${page}`, serializeUrlState(viewToUrl(v, keepT)));
  };
  // Re-read before writing: another tab may have saved or deleted a view since this one loaded.
  const commit = (change: (current: LocalView[]) => LocalView[]): boolean => {
    const next = change(readLocalViews(storage));
    if (!writeLocalViews(storage, next)) return false;
    setAll(next);
    return true;
  };
  const save = (e: FormEvent): void => {
    e.preventDefault();
    const name = title.trim();
    if (name === '') return;
    const params = currentParams();
    for (const k of NOT_SAVED) params.delete(k);
    const view: LocalView = {
      id: newId(),
      title: name,
      page,
      search: params.toString().replace(/%7E/g, '~'),
    };
    if (commit((current) => [...current, view])) {
      setSaving(false);
      setTitle('');
      setFailed(false);
    } else setFailed(true);
  };

  return (
    <>
      <Menu.Root>
        <Menu.Trigger className={CONTROL}>
          Views
          <ChevronDown size={16} aria-hidden />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end">
            <Menu.Popup className={`${POPUP} min-w-56`}>
              {configViews.length === 0 ? null : (
                <>
                  <div className={HEADING}>From config</div>
                  {configViews.map((v) => (
                    <Menu.Item key={v.id} onClick={() => applyConfig(v)} className={ITEM}>
                      {v.title}
                    </Menu.Item>
                  ))}
                </>
              )}
              <div className={HEADING}>Saved in this browser</div>
              {storage === null ? (
                <Menu.Item disabled className="px-3 py-1.5 text-sm text-muted">
                  Browser storage is unavailable
                </Menu.Item>
              ) : (
                local.map((v) => (
                  <div key={v.id} className="flex items-center">
                    <Menu.Item onClick={() => apply(v.search)} className={`${ITEM} flex-1`}>
                      {v.title}
                    </Menu.Item>
                    <Menu.Item
                      aria-label={`Delete view ${v.title}`}
                      onClick={() => commit((current) => current.filter((x) => x.id !== v.id))}
                      className="rounded-full p-1.5 text-ink-2 hover:bg-hairline"
                    >
                      <Trash2 size={14} aria-hidden />
                    </Menu.Item>
                  </div>
                ))
              )}
              <Menu.Item
                disabled={storage === null}
                onClick={() => setSaving(true)}
                className={`${ITEM} mt-1 flex items-center gap-1.5 border-t border-hairline data-[disabled]:text-muted data-[disabled]:hover:bg-transparent`}
              >
                <BookmarkPlus size={14} aria-hidden />
                Save current view…
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {saving ? (
        <Dialog.Root open onOpenChange={(open) => !open && setSaving(false)}>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 bg-ink/30" />
            <Dialog.Popup
              className={`${POPUP} fixed left-1/2 top-1/3 w-[26rem] max-w-[90vw] -translate-x-1/2 p-4`}
            >
              <Dialog.Title className="text-base font-semibold">Save current view</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted">
                Stores this page's query, grouping and view in this browser. The time range is not saved.
              </Dialog.Description>
              <form onSubmit={save} className="mt-3 flex flex-col gap-3">
                <input
                  aria-label="View title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="rounded-md border border-hairline bg-page px-2 py-1.5 text-sm"
                />
                {failed ? (
                  <p role="alert" className="text-sm text-critical">
                    Could not save: browser storage refused the write.
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <button type="submit" className={CONTROL} disabled={title.trim() === ''}>
                    Save
                  </button>
                  <Dialog.Close className={CONTROL}>Cancel</Dialog.Close>
                </div>
              </form>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  );
}
