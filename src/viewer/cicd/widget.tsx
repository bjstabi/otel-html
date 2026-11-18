import type { JSX } from 'react';
import type { WidgetRenderer } from '../dashboards/dashboard-page.js';
import { useCicd } from './use-cicd.js';

/** The `cicd` widget: one component that switches on its view. Each case is a placeholder until its view lands. */
export const CicdWidget: WidgetRenderer = ({ widget, scope }): JSX.Element => {
  const data = useCicd(widget, scope);
  if (widget.type !== 'cicd') return <div />;
  switch (widget.view) {
    case 'stat':
    case 'runs-trend':
    case 'runs':
    case 'jobs':
    case 'status-grid':
    case 'failures':
    case 'triggers':
    case 'queue':
    case 'minutes':
    case 'tests':
      return (
        <div className="p-3 text-sm text-muted">
          {widget.view}: {data.status === 'ready' ? `${data.runs.length} runs` : data.status}
        </div>
      );
  }
};
