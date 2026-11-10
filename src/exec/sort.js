//ORDER BY, in two forms: a full sort, and a top-n for when a LIMIT follows.
//either way the whole input has to be seen before the first row can be
//returned.

import { inBatches } from './batches.js';
import { BoundedHeap } from './heap.js';
import { compareValues } from './values.js';

//a comparator over entries of the form { keys, row }, where keys holds the
//value of each sort key for that row
function byKeys(keys) {
  const directions = keys.map((key) => (key.descending ? -1 : 1));
  return (a, b) => {
    for (let i = 0; i < directions.length; i++) {
      const order = compareValues(a.keys[i], b.keys[i]);
      if (order !== 0) return order * directions[i];
    }
    return 0;
  };
}

//the keys are worked out once per row up front. the comparator runs about
//n log n times, and should not evaluate an expression each time it does.
export async function* sort(input, keys) {
  const entries = [];
  for await (const batch of input) {
    for (const row of batch) entries.push({ keys: keys.map((key) => key.value(row)), row });
  }
  //the built-in sort is stable, so rows that tie keep the order they came in
  entries.sort(byKeys(keys));
  yield* inBatches(entries.map((entry) => entry.row));
}

//ORDER BY with a LIMIT. only the rows that could still be in the result are
//kept, in a heap, so the memory used is the size of the limit and not of the
//input, and most rows cost one comparison against the worst row kept.
export async function* topN(input, keys, count, offset) {
  const order = byKeys(keys);
  //rows that tie are told apart by the order they arrived in. that makes the
  //result exactly what a stable sort followed by a limit would have given.
  const heap = new BoundedHeap(count + offset, (a, b) => order(a, b) || a.arrival - b.arrival);
  let arrival = 0;
  for await (const batch of input) {
    for (const row of batch) {
      heap.offer({ keys: keys.map((key) => key.value(row)), row, arrival });
      arrival += 1;
    }
  }
  const rows = heap.sorted().slice(offset);
  yield* inBatches(rows.map((entry) => entry.row));
}
