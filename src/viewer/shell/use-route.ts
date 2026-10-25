import { useHashLocation } from 'wouter/use-hash-location';

type HashLocation = ReturnType<typeof useHashLocation>;

/** The hash route without its query: `#/traces?t=1~2` is the route `/traces`; the query belongs to the selection store. */
export function useRoute(): HashLocation {
  const [location, navigate] = useHashLocation();
  const q = location.indexOf('?');
  return [q >= 0 ? location.slice(0, q) : location, navigate];
}

/** Hash links: `/logs` becomes `#/logs`. */
export function routeHref(href: string): string {
  return `#${href}`;
}
