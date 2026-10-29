import { ArrowUpRight, GripVertical, Link2 } from 'lucide-react';
import { Component, type JSX, type ReactNode, useId } from 'react';
import type { Widget, WidgetType } from '../../dashboards/schema.js';
import { ErrorCard } from '../components/explorer-states.js';

const TYPE_TITLES: Record<WidgetType, string> = {
  timeline: 'Timeline',
  traces: 'Traces',
  logs: 'Logs',
  metric: 'Metrics',
  toplist: 'Top list',
  table: 'Table',
};

/** The widget's own title, else its type's. */
export function widgetTitle(w: Widget): string {
  return w.title ?? TYPE_TITLES[w.type];
}

/** Keeps a widget that throws while rendering inside its frame; a change of `resetKey` (its inputs) tries again. */
class WidgetBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { error: Error | null; resetKey: string }
> {
  override state: { error: Error | null; resetKey: string } = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error: Error | null; resetKey: string },
  ): { error: Error | null; resetKey: string } | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  override render(): ReactNode {
    const { error } = this.state;
    return error === null ? (
      this.props.children
    ) : (
      <ErrorCard title="This widget failed to render" message={error.message} />
    );
  }
}

export interface WidgetFrameProps {
  /** Identifies the widget's inputs: when it changes, a failed widget is rendered again. */
  resetKey: string;
  widget: Widget;
  subtitle: string;
  /** Whether the widget follows the selection; null hides the toggle (the timeline never follows). */
  following: boolean | null;
  onFollow(v: boolean): void;
  openIn: { label: string; onOpen(): void } | null;
  editing: boolean;
  children: ReactNode;
}

/** The card around one widget: drag handle (in edit mode), title and subtitle, the follow toggle and Open in. */
export function WidgetFrame(props: WidgetFrameProps): JSX.Element {
  const { widget, following, openIn } = props;
  const title = widgetTitle(widget);
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-widget={widget.id}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-card border border-hairline bg-surface"
    >
      <header className="flex items-center gap-2 border-b border-hairline px-3 py-1.5">
        {props.editing && (
          <button
            type="button"
            aria-label={`Move ${title}`}
            className="oh-drag-handle cursor-grab rounded-md p-0.5 text-muted hover:bg-hairline"
          >
            <GripVertical size={16} aria-hidden />
          </button>
        )}
        <h2 id={titleId} className="text-sm font-semibold">
          {title}
        </h2>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{props.subtitle}</span>
        {following !== null && (
          <button
            type="button"
            aria-pressed={following}
            onClick={() => props.onFollow(!following)}
            title={following ? 'Follows the selection' : 'Ignores the selection'}
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-ink-2 hover:bg-hairline aria-pressed:bg-ink aria-pressed:text-page"
          >
            <Link2 size={12} aria-hidden />
            follows selection
          </button>
        )}
        {openIn !== null && (
          <button
            type="button"
            onClick={openIn.onOpen}
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-accent hover:bg-hairline"
          >
            {openIn.label}
            <ArrowUpRight size={12} aria-hidden />
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <WidgetBoundary resetKey={props.resetKey}>{props.children}</WidgetBoundary>
      </div>
    </section>
  );
}
