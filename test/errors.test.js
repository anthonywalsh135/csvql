import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BindError, CsvqlError, SqlSyntaxError, describeError } from '../src/errors.js';

test('every error kind is a CsvqlError named after its class', () => {
  const error = new BindError('unknown column "nmae"', 7);
  assert.ok(error instanceof CsvqlError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'BindError');
  assert.equal(error.position, 7);
});

test('an error with a position is shown with a caret under it', () => {
  const sql = 'SELECT nmae FROM people';
  const error = new BindError('unknown column "nmae"', 7);
  assert.equal(
    describeError(error, sql),
    ['error: unknown column "nmae"', '  SELECT nmae FROM people', '         ^'].join('\n'),
  );
});

test('only the offending line of a multi-line query is shown', () => {
  const sql = 'SELECT name\nFORM people\nWHERE age > 30';
  const error = new SqlSyntaxError('expected end of query but found "people"', 17);
  assert.equal(
    describeError(error, sql),
    ['error: expected end of query but found "people"', '  FORM people', '       ^'].join('\n'),
  );
});

test('tabs and carriage returns do not move the caret', () => {
  const sql = 'SELECT\t1 +\r\n\t* 2';
  assert.equal(
    describeError(new SqlSyntaxError('unexpected "*"', 13), sql),
    ['error: unexpected "*"', '   * 2', '   ^'].join('\n'),
  );
  assert.equal(
    describeError(new SqlSyntaxError('unexpected "+"', 9), sql),
    ['error: unexpected "+"', '  SELECT 1 +', '           ^'].join('\n'),
  );
});

test('a position at the end of the query points just past the last character', () => {
  const error = new SqlSyntaxError('unexpected end of query', 8);
  assert.equal(
    describeError(error, 'SELECT 1'),
    ['error: unexpected end of query', '  SELECT 1', '          ^'].join('\n'),
  );
});

test('errors without a position are a single line', () => {
  assert.equal(describeError(new BindError('table "x" not found')), 'error: table "x" not found');
  assert.equal(describeError(new Error('disk on fire'), 'SELECT 1'), 'error: disk on fire');
});
