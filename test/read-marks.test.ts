import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanReadMark, cleanReadMarks } from '../workers/console/src/read-marks.ts';

test('accepts legacy ISO read marks and object marks with v:null', () => {
  assert.deepEqual(cleanReadMark('2026-08-14T00:00:00.000Z'), {
    v: '2026-08-14T00:00:00.000Z',
    at: '2026-08-14T00:00:00.000Z',
  });
  assert.deepEqual(cleanReadMark({ v: null, at: '2026-08-15T01:00:00.000Z' }), {
    v: null,
    at: '2026-08-15T01:00:00.000Z',
  });
  assert.equal(cleanReadMark('not-a-date'), null);
});

test('keeps a bounded map of cleaned read marks', () => {
  const marks = cleanReadMarks({
    'examples/a.html': '2026-08-14T00:00:00.000Z',
    'examples/b.html': { v: null, at: '2026-08-15T01:00:00.000Z' },
    '': { v: '2026-08-15T01:00:00.000Z', at: '2026-08-15T01:00:00.000Z' },
  }, 800);
  assert.equal(marks['examples/a.html'].v, '2026-08-14T00:00:00.000Z');
  assert.equal(marks['examples/b.html'].v, null);
  assert.equal('' in marks, false);
});
