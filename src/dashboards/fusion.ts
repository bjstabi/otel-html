import { type Dashboard, DashboardSchema } from './schema.js';

/** The built-in dashboard (spec §6.5): one timeline, with Traces, Logs and Metrics that follow the selection. */
export const FUSION: Dashboard = DashboardSchema.parse({
  id: 'fusion',
  title: 'Fusion',
  description: 'Every signal on one timeline, with Traces, Logs and Metrics that follow your selection',
  variables: ['service.name', 'deployment.environment.name', 'host.name'],
  widgets: [
    { id: 'timeline', type: 'timeline', x: 0, y: 0, w: 12, h: 6 },
    { id: 'traces', type: 'traces', x: 0, y: 6, w: 7, h: 13 },
    { id: 'logs', type: 'logs', x: 7, y: 6, w: 5, h: 13 },
    { id: 'metrics', type: 'metric', x: 0, y: 19, w: 12, h: 10 },
  ],
});
