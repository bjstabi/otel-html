import type { JSX } from 'react';
import { defaultStyles, JsonView, type Props } from 'react-json-view-lite';

const STYLE: NonNullable<Props['style']> = {
  ...defaultStyles,
  container: 'oh-json',
  label: 'oh-json-key',
  clickableLabel: 'oh-json-key',
  stringValue: 'oh-json-str',
  numberValue: 'oh-json-num',
  booleanValue: 'oh-json-other',
  otherValue: 'oh-json-other',
  nullValue: 'oh-json-null',
  undefinedValue: 'oh-json-null',
  punctuation: 'oh-json-punct',
  collapsedContent: 'oh-json-punct',
};

/** A collapsible tree for kvlist and array values. Values are React text nodes inside the library; nothing is HTML. */
export function JsonTree(props: { data: unknown; label: string }): JSX.Element {
  const data: object =
    typeof props.data === 'object' && props.data !== null ? props.data : { value: props.data };
  return (
    <JsonView data={data} style={STYLE} aria-label={props.label} shouldExpandNode={(level) => level < 2} />
  );
}
