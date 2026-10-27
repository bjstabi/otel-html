import type { HistoryPort } from './selection.js';

const DEFAULT_ROUTE = '/traces';

function split(hash: string): { route: string; query: string } {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const qi = h.indexOf('?');
  const route = qi >= 0 ? h.slice(0, qi) : h;
  return { route: route === '' ? DEFAULT_ROUTE : route, query: qi >= 0 ? h.slice(qi + 1) : '' };
}

/** Hash routing `#/<route>?<query>`: the port reads and writes only the query; the route is preserved. */
export function createHashHistory(win: Window): HistoryPort {
  return {
    read: () => split(win.location.hash).query,
    write(s, mode) {
      const { route } = split(win.location.hash);
      const hash = `#${route}${s === '' ? '' : `?${s}`}`;
      if (hash === win.location.hash) return;
      try {
        if (mode === 'push') win.history.pushState(null, '', hash);
        else win.history.replaceState(null, '', hash);
      } catch {
        // pushState/replaceState can throw in sandboxed documents; assigning the hash always works.
        win.location.hash = hash;
      }
    },
    subscribe(cb) {
      win.addEventListener('hashchange', cb);
      win.addEventListener('popstate', cb);
      return () => {
        win.removeEventListener('hashchange', cb);
        win.removeEventListener('popstate', cb);
      };
    },
  };
}
