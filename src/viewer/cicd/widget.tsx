import type { JSX } from 'react';
import type { WidgetRenderer } from '../dashboards/dashboard-page.js';

/** The `cicd` widget: one component that switches on its view. Each case is a placeholder until its view lands. */
export const CicdWidget: WidgetRenderer = ({ widget }): JSX.Element => {
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
      return <div className="p-3 text-sm text-muted">{widget.view}</div>;
  }
};
