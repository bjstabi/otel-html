import type { JSX } from 'react';
import type { WidgetRenderer } from '../dashboards/dashboard-page.js';
import { useCicd } from './use-cicd.js';
import { RunsView } from './views/runs.js';
import { RunsTrendView } from './views/runs-trend.js';
import { StatView } from './views/stat.js';

/** A view that has not landed yet. */
const Placeholder: WidgetRenderer = ({ widget, scope }): JSX.Element => {
  const data = useCicd(widget, scope);
  return (
    <div className="p-3 text-sm text-muted">
      {widget.type === 'cicd' ? widget.view : ''}:{' '}
      {data.status === 'ready' ? `${data.runs.length} runs` : data.status}
    </div>
  );
};

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
    case 'status-grid':
    case 'failures':
    case 'triggers':
    case 'queue':
    case 'minutes':
    case 'tests':
      return <Placeholder {...props} />;
  }
};
