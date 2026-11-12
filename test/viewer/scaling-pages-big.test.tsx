import './scaling-pages-mocks.js';
import { afterAll, describe, test } from 'vitest';
import { pageShapes } from '../../test-support/scaling/generator.js';
import { closeMeasured } from '../../test-support/scaling/measure.js';
import { measureShape, shapeFile } from './scaling-pages-support.js';

const { OTEL_HTML_SCALING: SCALING, OTEL_HTML_SCALING_OUT: OUT } = process.env;

/**
 * The page shapes with one large partition (8, 14 and 22 production-size groups: a real report has one), apart from
 * `scaling-pages.test.tsx` because a report of a million spans needs a heap of its own.
 */
describe.skipIf(SCALING !== '1' || OUT === undefined)(
  'a page is measured whole with a large partition',
  () => {
    afterAll(async () => {
      await closeMeasured();
    });

    describe.each(['dense', 'sparse'] as const)('%s', (spacing) => {
      test.each(
        pageShapes(spacing)
          .filter((s) => s.bigRowGroups !== undefined)
          .map((shape) => [shapeFile(shape), shape] as const),
      )(
        'the five pages on %s',
        async (_file, shape) => {
          await measureShape(shape, OUT ?? '');
        },
        900_000,
      );
    });
  },
);
