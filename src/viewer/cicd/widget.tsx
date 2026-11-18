import type { JSX } from 'react';
import type { WidgetRenderer } from '../dashboards/dashboard-page.js';
import { FailuresView } from './views/failures.js';
import { JobsView } from './views/jobs.js';
import { MinutesView } from './views/minutes.js';
import { QueueView } from './views/queue.js';
import { RunsView } from './views/runs.js';
import { RunsTrendView } from './views/runs-trend.js';
import { StatView } from './views/stat.js';
import { StatusGridView } from './views/status-grid.js';
import { TestsView } from './views/tests.js';
import { TriggersView } from './views/triggers.js';

/** The `cicd` widget: one component that switches on its view. */
export const CicdWidget: WidgetRenderer = (props): JSX.Element => {
  const { widget } = props;
  if (widget.type !== 'cicd') return <div />;
  switch (widget.view) {
    case 'stat':
      return <StatView {...props} />;
    case 'runs-trend':
      return <RunsTrendView {...props} />;
    case 'runs':
      return <RunsView {...props} />;
    case 'jobs':
      return <JobsView {...props} />;
    case 'status-grid':
      return <StatusGridView {...props} />;
    case 'failures':
      return <FailuresView {...props} />;
    case 'triggers':
      return <TriggersView {...props} />;
    case 'queue':
      return <QueueView {...props} />;
    case 'minutes':
      return <MinutesView {...props} />;
    case 'tests':
      return <TestsView {...props} />;
  }
};
