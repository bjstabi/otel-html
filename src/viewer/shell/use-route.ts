import { useHashLocation } from 'wouter/use-hash-location';

type HashLocation = ReturnType<typeof useHashLocation>;

/** The hash route without its query: `#/traces?t=1~2` is the route `/traces`; the query belongs to the selection store. */
export function useRoute(): HashLocation {
  const [location, navigate] = useHashLocation();
  const q = location.indexOf('?');
  return [q >= 0 ? location.slice(0, q) : location, navigate];
}

/** The route of the window's hash (`#/logs?x=1` is `/logs`; an empty hash is `/`). */
export function currentRoute(win: Window): string {
  const h = win.location.hash.startsWith('#') ? win.location.hash.slice(1) : win.location.hash;
  const qi = h.indexOf('?');
  const route = qi >= 0 ? h.slice(0, qi) : h;
  return route === '' ? '/' : route;
}

/**
 * Go to `route`, carrying the current selection query so the URL stays the single source of truth for the
 * shared selection (window, text, condition...). Pushes a history entry (or, with `replace`, swaps the current one:
 * redirects) and notifies hash listeners.
 */
export function navigateRoute(win: Window, route: string, search: string, replace = false): void {
  const oldURL = win.location.href;
  const hash = `#${route}${search === '' ? '' : `?${search}`}`;
  if (hash === win.location.hash) return;
  if (replace) win.history.replaceState(null, '', hash);
  else win.history.pushState(null, '', hash);
  win.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: win.location.href }));
}

/** Hash links: `/logs` becomes `#/logs`. */
export function routeHref(href: string): string {
  return `#${href}`;
}
