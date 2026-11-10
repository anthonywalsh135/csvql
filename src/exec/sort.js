//ORDER BY. the whole input has to be seen before the first row can be
//returned, so this is one of the operators that holds rows in memory.

import { inBatches } from './batches.js';
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
