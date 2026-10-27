import { Tabs } from '@base-ui/react/tabs';
import { ChevronRight } from 'lucide-react';
import { type JSX, useMemo, useState } from 'react';
import { type AnyValue, anyValueToDisplay } from '../../model/anyvalue.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { SpanId, UnixNanos } from '../../model/ids.js';
import { type SpanEventRecord, SpanKind, type SpanRecord, StatusCode } from '../../model/records.js';
import { formatDuration, formatTime } from '../../semconv/formatters.js';
import { addAttributeFilter } from '../components/attribute-filter.js';
import { AttributeGroups, loadPins, savePins } from '../components/attribute-groups.js';
import { type AttributeActions, ResourceTab } from '../components/resource-tab.js';
import type { DataSource, TraceDetail } from '../data/data-source.js';
import { useSelection } from '../state/selection-context.js';
import { useColorAssigner } from '../theme/colors-context.js';
import { ServiceChip, StatusDot } from './columns.js';
import { EventsTab, formatOffset, LinksTab, Muted } from './span-detail-tabs.js';
import { availableSpanTabs, isSpanTabId, type SpanTabId } from './tabs.js';
import { traceFacts } from './trace-facts.js';

/** What the span section receives to render the selected span. */
export interface SpanSectionProps {
  detail: TraceDetail;
  spanId: SpanId | null;
  epoch: UnixNanos;
  dataSource: DataSource;
}

const TAB_BASE =
  'rounded-full px-3 py-1 text-sm text-ink-2 hover:bg-hairline data-[active]:bg-ink data-[active]:text-surface';

function attr(e: SpanEventRecord, key: string): string | null {
  const v = e.attributes.get(key);
  return v === undefined ? null : anyValueToDisplay(v);
}

function Exception(props: { event: SpanEventRecord; span: SpanRecord }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { event } = props;
  const type = attr(event, 'exception.type');
  const message = attr(event, 'exception.message');
  const stack = attr(event, 'exception.stacktrace');
  return (
    <li className="rounded-card border border-critical p-3">
      <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-sm">
        <span className="font-semibold text-critical">Exception</span>
        <span className="font-semibold break-all">{type ?? 'unknown type'}</span>
        <span className="text-xs tabular-nums text-ink-2">{formatOffset(props.span.start, event.time)}</span>
      </p>
      {message !== null && (
        <p className="mt-1 font-mono text-sm break-words whitespace-pre-wrap">{message}</p>
      )}
      {stack !== null && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="mt-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-hairline"
          >
            <ChevronRight size={14} aria-hidden className={open ? 'rotate-90' : ''} />
            Stack trace
          </button>
          {open && (
            <pre className="mt-1 max-h-72 overflow-auto font-mono text-xs whitespace-pre-wrap break-all">
              {stack}
            </pre>
          )}
        </>
      )}
    </li>
  );
}

function CoreFacts(props: { row: { span: SpanRecord }; epoch: UnixNanos; traceStart: number }): JSX.Element {
  const { span } = props.row;
  const failed = span.status.code === StatusCode.ERROR;
  const rows: [string, JSX.Element | string][] = [
    ['Span ID', span.spanId],
    ['Parent', span.parentSpanId ?? 'none (root)'],
    ['Kind', SpanKind[span.kind] ?? String(span.kind)],
    [
      'Status',
      <span key="s" className="inline-flex flex-wrap items-center gap-x-2">
        <StatusDot
          error={failed}
          label={failed ? 'Error' : span.status.code === StatusCode.OK ? 'Ok' : 'Unset'}
        />
        {span.status.message !== '' && (
          <span className="break-words whitespace-pre-wrap">{span.status.message}</span>
        )}
      </span>,
    ],
    [
      'Start',
      `${formatTime(span.start, props.epoch)} (+${formatDuration(Math.max(0, span.start - props.traceStart))})`,
    ],
  ];
  return (
    <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="min-w-0 font-mono text-xs break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The selected span: header, then Overview (exceptions first, pinned and semconv attribute groups), Events, Links
 * and Resource tabs. Attribute filter actions edit the shared query condition.
 */
export function SpanSection(props: SpanSectionProps): JSX.Element {
  const { detail, spanId, epoch, dataSource } = props;
  const sel = useSelection((s) => s);
  const colors = useColorAssigner();
  const [pins, setPins] = useState<string[]>(loadPins);
  const [error, setError] = useState<string | null>(null);
  const row = useMemo(() => detail.spans.find((r) => r.span.spanId === spanId) ?? null, [detail, spanId]);
  const facts = useMemo(() => traceFacts(detail), [detail]);

  if (row === null) {
    return (
      <section
        aria-label="Span details"
        className="m-3 rounded-card border border-dashed border-hairline p-4 text-sm text-ink-2"
      >
        <p className="font-semibold">Span details</p>
        <p className="mt-1">Select a span in the trace above.</p>
      </section>
    );
  }
  const { span } = row;

  const togglePin = (key: string): void => {
    const next = pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key];
    setPins(next);
    savePins(next);
  };
  const filter =
    (scope: 'attribute' | 'resource', op: '==' | '!=') =>
    (key: string, value: AnyValue): void => {
      try {
        setError(null);
        sel.setCondition(addAttributeFilter(sel.condition, scope, key, value, op));
      } catch (e) {
        setError(e instanceof OtelHtmlError ? e.message : String(e));
      }
    };
  const spanActions: AttributeActions = {
    onFilter: filter('attribute', '=='),
    onExclude: filter('attribute', '!='),
    onTogglePin: togglePin,
  };
  const resourceActions: AttributeActions = {
    onFilter: filter('resource', '=='),
    onExclude: filter('resource', '!='),
  };

  const tabs = availableSpanTabs(span);
  const wanted = sel.tabs.span;
  const active: SpanTabId = tabs.find((t) => t.id === wanted)?.id ?? 'overview';
  const percentile = dataSource.percentileOf(row.service, row.resource, row.durationNs);
  const share =
    facts.durationNs > 0
      ? `${Math.min(100, Math.round((row.durationNs / facts.durationNs) * 100))}% of trace`
      : 'share unknown';
  const exceptions = span.events.filter((e) => e.name === 'exception');

  return (
    <section aria-label="Span details" className="flex flex-col gap-2 p-3">
      <div data-testid="span-header" className="flex flex-col gap-1">
        <h3 className="min-w-0 text-base font-semibold break-words">{span.name}</h3>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <ServiceChip service={row.service} colors={colors} />
          <span className="font-mono tabular-nums">{formatDuration(row.durationNs)}</span>
          <span className="text-ink-2">{share}</span>
          {percentile !== null && (
            <span
              title="Percentile of this span's duration among spans of the same service and resource"
              className="rounded-full bg-ink/10 px-2 py-0.5 text-xs"
            >
              p{Math.round(percentile)}
            </span>
          )}
        </p>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
      <Tabs.Root
        value={active}
        onValueChange={(v) => {
          if (typeof v === 'string' && isSpanTabId(v)) sel.setTab('span', v);
        }}
      >
        <Tabs.List aria-label="Span views" className="flex flex-wrap gap-1 pb-2">
          {tabs.map((t) => (
            <Tabs.Tab key={t.id} value={t.id} className={TAB_BASE}>
              {t.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value={active} className="outline-none">
          {active === 'overview' && (
            <>
              {exceptions.length > 0 && (
                <ul
                  data-testid="span-exceptions"
                  aria-label="Exceptions"
                  className="mb-3 flex flex-col gap-2"
                >
                  {exceptions.map((e, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: events have no identity of their own
                    <Exception key={i} event={e} span={span} />
                  ))}
                </ul>
              )}
              <CoreFacts row={row} epoch={epoch} traceStart={facts.start} />
              <AttributeGroups attributes={span.attributes} pinned={pins} {...spanActions} />
              {span.droppedAttributesCount > 0 && (
                <Muted>{span.droppedAttributesCount} attributes dropped</Muted>
              )}
            </>
          )}
          {active === 'events' && <EventsTab span={span} />}
          {active === 'links' && (
            <LinksTab span={span} dataSource={dataSource} onSelectSpan={(id) => sel.selectSpan(id)} />
          )}
          {active === 'resource' && (
            <ResourceTab
              counts={[
                ['Span attributes', span.droppedAttributesCount],
                ['Events', span.droppedEventsCount],
                ['Links', span.droppedLinksCount],
              ]}
              resource={detail.resources(span.resource)}
              scope={detail.scopes(span.scope)}
              resourceActions={resourceActions}
            />
          )}
        </Tabs.Panel>
      </Tabs.Root>
    </section>
  );
}
