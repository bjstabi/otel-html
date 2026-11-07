import { anyValueToDisplay } from '../../src/model/anyvalue.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { UnixNanos } from '../../src/model/ids.js';
import {
  type LogRecordRecord,
  logTime,
  logTimeSource,
  type ResourceRecord,
  type ScopeRecord,
} from '../../src/model/records.js';
import { ATTR_HOST_NAME } from '../../src/semconv/attributes.js';
import { serviceName } from '../../src/semconv/resource-name.js';
import { type LogEntry, logRef } from '../../src/viewer/data/log-query.js';

/** Builds log entries (rows plus evaluator targets) from records and resource and scope tables, for tests. */
export function toLogEntries(
  chunk: {
    readonly n: number;
    readonly resources: readonly ResourceRecord[];
    readonly scopes: readonly ScopeRecord[];
  },
  logs: readonly LogRecordRecord[],
  epoch: UnixNanos,
  path: string,
): LogEntry[] {
  return logs.map((log, i) => {
    const resource = chunk.resources[log.resource];
    const scope = chunk.scopes[log.scope];
    if (resource === undefined || scope === undefined) {
      throw new OtelHtmlError('invalid-report', {
        path: `${path}[${i}]`,
        expected: 'resource and scope refs inside the chunk tables',
        actual: `resource ${log.resource}, scope ${log.scope}`,
      });
    }
    const hostValue = resource.attributes.get(ATTR_HOST_NAME);
    return {
      row: {
        ref: logRef(chunk.n, i),
        n: chunk.n,
        i,
        log,
        resource,
        scope,
        time: logTime(log),
        timeSource: logTimeSource(log),
        service: serviceName(resource),
        host: hostValue === undefined ? null : anyValueToDisplay(hostValue),
      },
      target: { log, resource, scope, epoch },
    };
  });
}
