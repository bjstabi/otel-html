import type { JSX } from 'react';
import type { ResourceRecord, ScopeRecord } from '../../model/records.js';
import { AttributeGroups, type AttributeGroupsProps } from './attribute-groups.js';

export type AttributeActions = Omit<AttributeGroupsProps, 'attributes' | 'pinned'>;

const ID = 'font-mono text-xs break-all';

function Counts(props: { rows: readonly (readonly [string, number])[] }): JSX.Element {
  return (
    <section aria-label="Dropped counts" className="mb-3">
      <h4 className="mb-1 text-xs font-semibold tracking-wide text-ink-2 uppercase">Dropped counts</h4>
      <dl className="grid grid-cols-[auto_auto] justify-start gap-x-4 gap-y-1">
        {props.rows.map(([label, n]) => (
          <div key={label} className="contents">
            <dt className="text-sm text-ink-2">{label}</dt>
            <dd className="font-mono text-sm tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Schema(props: { label: string; url: string }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-x-3">
      <dt className="text-sm text-ink-2">{props.label}</dt>
      <dd className={ID}>{props.url === '' ? 'none' : props.url}</dd>
    </div>
  );
}

export function ResourceTab(props: {
  /** Dropped counts of the signal record itself, listed before the resource and scope counts. */
  counts: readonly (readonly [string, number])[];
  resource: ResourceRecord;
  scope: ScopeRecord;
  resourceActions: AttributeActions;
}): JSX.Element {
  const { resource, scope } = props;
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">Resource</h3>
      <AttributeGroups attributes={resource.attributes} pinned={[]} {...props.resourceActions} />
      <h3 className="mt-4 mb-1 text-sm font-semibold">
        Scope <span className="font-mono text-xs font-normal">{scope.name}</span>
        {scope.version !== '' && <span className="font-mono text-xs font-normal"> {scope.version}</span>}
      </h3>
      <AttributeGroups attributes={scope.attributes} pinned={[]} />
      <section aria-label="Schema URLs" className="my-3">
        <h4 className="mb-1 text-xs font-semibold tracking-wide text-ink-2 uppercase">Schema URLs</h4>
        <dl className="flex flex-col gap-1">
          <Schema label="Resource" url={resource.schemaUrl} />
          <Schema label="Scope" url={scope.schemaUrl} />
        </dl>
      </section>
      <Counts
        rows={[
          ...props.counts,
          ['Resource attributes', resource.droppedAttributesCount],
          ['Scope attributes', scope.droppedAttributesCount],
        ]}
      />
    </div>
  );
}
