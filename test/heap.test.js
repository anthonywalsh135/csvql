import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BoundedHeap } from '../src/exec/heap.js';
import { createRandom } from './support/random.js';

const ascending = (a, b) => a - b;

function smallest(capacity, items, compare = ascending) {
  const heap = new BoundedHeap(capacity, compare);
  for (const item of items) heap.offer(item);
  return heap.sorted();
}

test('the heap keeps the smallest items, in order', () => {
  assert.deepEqual(smallest(3, [5, 1, 4, 2, 3]), [1, 2, 3]);
  assert.deepEqual(smallest(3, [1, 2, 3, 4, 5]), [1, 2, 3]);
  assert.deepEqual(smallest(3, [5, 4, 3, 2, 1]), [1, 2, 3]);
});

test('fewer items than the capacity are all kept', () => {
  assert.deepEqual(smallest(10, [3, 1, 2]), [1, 2, 3]);
  assert.deepEqual(smallest(10, []), []);
});

test('a heap with no capacity keeps nothing', () => {
  assert.deepEqual(smallest(0, [3, 1, 2]), []);
});

test('repeated items are kept as often as they fit', () => {
  assert.deepEqual(smallest(4, [2, 2, 1, 2, 2, 1, 3]), [1, 1, 2, 2]);
});

test('the comparator decides what smallest means', () => {
  const descending = (a, b) => b - a;
  assert.deepEqual(smallest(2, [5, 1, 4, 2, 3], descending), [5, 4]);
});

test('the heap agrees with sorting everything, for random input', () => {
  const random = createRandom(7);
  for (let round = 0; round < 200; round++) {
    const items = Array.from({ length: random.int(0, 60) }, () => random.int(-20, 20));
    const capacity = random.int(0, 25);
    const expected = items.toSorted(ascending).slice(0, capacity);
    assert.deepEqual(smallest(capacity, items), expected, `round ${round}`);
  }
});
