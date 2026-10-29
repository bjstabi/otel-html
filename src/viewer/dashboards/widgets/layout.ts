import { useMemo } from 'react';
import { parseUnixNanos, type UnixNanos } from '../../../model/ids.js';
import type { DataSource } from '../../data/data-source.js';

/** Card header, padding and border around a widget's body; the body gets what is left of the widget's height. */
export const FRAME_CHROME_PX = 52;

/** The report's epoch, which widgets need to turn report-relative times into dates. */
export function useEpoch(dataSource: DataSource): UnixNanos {
  return useMemo(
    () => parseUnixNanos(dataSource.manifest.epochUnixNano, 'manifest.epochUnixNano'),
    [dataSource],
  );
}
