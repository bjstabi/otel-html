export const EXPLORER_VIEWS = [
  'list',
  'timeseries',
  'toplist',
  'bar',
  'table',
  'pointplot',
  'treemap',
  'pie',
  'scatter',
] as const;

export type ExplorerView = (typeof EXPLORER_VIEWS)[number];
