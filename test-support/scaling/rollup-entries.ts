import { CATALOGUE, type CatalogueEntry } from '../../src/viewer/data/catalogue.js';
import { type RequestShape, type RouteNeed, rawOnly, routeOf } from '../../src/viewer/data/route.js';

/** What the shape of a catalogue entry reads, by the condition kind its id names. */
export function shapesOf(e: CatalogueEntry): RequestShape[] {
  const table = e.method === 'queryLogs' ? 'logs' : 'spans';
  const needs: RouteNeed[] = e.method === 'services' ? ['services'] : [...(e.needs ?? [])];
  const reads = new Set<string>();
  if (e.id.includes('.sortkey.')) reads.add('service_name');
  if (e.id.includes('.statkey.')) reads.add('resource:run.id');
  if (e.id.includes('.attr.') && !e.id.includes('facets')) reads.add('attr:http.route');
  return needs.map((need) => ({
    table,
    need,
    mode: e.id.includes('.traces') ? 'traces' : table === 'spans' ? 'spans' : 'logs',
    long: true,
    reads,
    residual: e.id.includes('.residual.'),
    text: e.id.includes('.text.'),
  }));
}

/** Every catalogue entry the router sends to `measures` and a rollup may answer, as it runs under a long window. */
export const ROLLUP_ENTRIES: readonly CatalogueEntry[] = CATALOGUE.filter(
  (e) =>
    e.id.endsWith('.long') &&
    ['querySpans', 'queryLogs', 'services'].includes(e.method) &&
    shapesOf(e).some((s) => routeOf(s) === 'measures' && !rawOnly(s)),
);
