import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ExecutionError } from '../src/errors.js';
import { createAggregate } from '../src/exec/aggregates.js';
import { compareValues, describeValue, encodeKey, truth } from '../src/exec/values.js';

function aggregate(name, values, distinct = false) {
  const accumulator = createAggregate(name, distinct);
  for (const value of values) accumulator.add(value);
  return accumulator.result();
}

test('there is one ordering across every type of value', () => {
  const sorted = [null, false, true, -5, 0, 2.5, 10, '', '10', '9', 'A', 'a'];
  const shuffled = ['a', 10, null, true, '9', 0, 'A', false, '', -5, '10', 2.5];
  assert.deepEqual(shuffled.sort(compareValues), sorted);
});

test('equal values compare as zero, whatever their type', () => {
  for (const value of [null, true, 0, 1.5, '', 'x']) {
    assert.equal(compareValues(value, value), 0);
  }
  assert.equal(compareValues(1, 1.0), 0);
  assert.notEqual(compareValues(1, '1'), 0);
  assert.notEqual(compareValues(0, false), 0);
});

test('a key is the same for two lists only when the lists are equal', () => {
  const lists = [
    [],
    [null],
    [null, null],
    [1],
    ['1'],
    [true],
    ['t;'],
    [1, 2],
    [12],
    ['1', '2'],
    ['12'],
    ['a', 'b'],
    ['ab'],
    ['a;sb'],
    ['', 'ab'],
    ['ab', ''],
    ['n;'],
    ['2:ab'],
    [1.5, 'x'],
    [false, null],
  ];
  const keys = lists.map(encodeKey);
  assert.equal(new Set(keys).size, lists.length, 'two different lists share a key');
  assert.equal(encodeKey([1, 'a', null, true]), encodeKey([1.0, 'a', null, true]));
});

test('conditions accept booleans, numbers and null', () => {
  assert.equal(truth(true), true);
  assert.equal(truth(false), false);
  assert.equal(truth(null), null);
  assert.equal(truth(3), true);
  assert.equal(truth(0), false);
  assert.throws(() => truth('true'), ExecutionError);
});

test('values are described for error messages', () => {
  assert.equal(describeValue(null), 'null');
  assert.equal(describeValue(5), 'the number 5');
  assert.equal(describeValue(false), 'the boolean false');
  assert.equal(describeValue('n/a'), "the text 'n/a'");
  assert.equal(describeValue('x'.repeat(40)), `the text '${'x'.repeat(30)}...'`);
});

test('COUNT counts what it is given', () => {
  assert.equal(aggregate('COUNT', []), 0);
  assert.equal(aggregate('COUNT', ['a', 'b', 'a']), 3);
  assert.equal(aggregate('COUNT', ['a', 'b', 'a'], true), 2);
});

test('SUM and AVG of nothing are null, not zero', () => {
  assert.equal(aggregate('SUM', []), null);
  assert.equal(aggregate('AVG', []), null);
});

test('SUM and AVG add numbers', () => {
  assert.equal(aggregate('SUM', [1, 2, 3.5]), 6.5);
  assert.equal(aggregate('AVG', [1, 2, 3, 6]), 3);
  assert.equal(aggregate('SUM', [5, 5, 7], true), 12);
  assert.equal(aggregate('AVG', [5, 5, 8], true), 6.5);
});

test('SUM does not lose small numbers next to large ones', () => {
  assert.equal(aggregate('SUM', [1e100, 1, -1e100]), 1);
  const tenths = Array.from({ length: 1_000_000 }, () => 0.1);
  assert.equal(aggregate('SUM', tenths), 100000);
  //the same sum done the obvious way drifts in the tenth significant figure
  assert.notEqual(
    tenths.reduce((total, value) => total + value, 0),
    100000,
  );
});

test('a sum that overflows is infinite rather than not a number', () => {
  assert.equal(aggregate('SUM', [1e308, 1e308]), Infinity);
});

test('SUM and AVG refuse anything that is not a number', () => {
  assert.throws(
    () => aggregate('SUM', [1, 'n/a']),
    (error) =>
      error instanceof ExecutionError &&
      /SUM expects numbers but got the text 'n\/a'/.test(error.message),
  );
  assert.throws(() => aggregate('AVG', [true]), /AVG expects numbers but got the boolean true/);
});

test('MIN and MAX use the ordering of values, so they work on text too', () => {
  assert.equal(aggregate('MIN', [3, 1, 2]), 1);
  assert.equal(aggregate('MAX', [3, 1, 2]), 3);
  assert.equal(aggregate('MIN', ['pear', 'apple', 'fig']), 'apple');
  assert.equal(aggregate('MAX', ['pear', 'apple', 'fig']), 'pear');
  assert.equal(aggregate('MAX', [10, '9']), '9');
  assert.equal(aggregate('MIN', []), null);
  assert.equal(aggregate('MAX', []), null);
});
