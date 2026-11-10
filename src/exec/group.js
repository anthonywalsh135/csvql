//GROUP BY, done with a hash table: one entry per group, holding the group's
//key values and a running accumulator for each aggregate. the input is read
//once and can arrive in any order.

import { createAggregate } from './aggregates.js';
import { inBatches } from './batches.js';
import { encodeKey } from './values.js';

export async function* aggregate(input, groupExprs, aggregates) {
  const groups = new Map();
  const start = (values) => ({
    values,
    states: aggregates.map(({ func, distinct }) => createAggregate(func, distinct)),
  });

  for await (const batch of input) {
    for (const row of batch) {
      const values = groupExprs.map((expr) => expr(row));
      //a map tells 1 from '1' and treats null as a key like any other, so a
      //single value can be its own key. several have to be encoded into one.
      const key = values.length === 1 ? values[0] : encodeKey(values);
      let group = groups.get(key);
      if (group === undefined) {
        group = start(values);
        groups.set(key, group);
      }
      for (let i = 0; i < aggregates.length; i++) {
        const { arg } = aggregates[i];
        if (arg === null) {
          group.states[i].add();
        } else {
          const value = arg(row);
          if (value !== null) group.states[i].add(value);
        }
      }
    }
  }

  //without GROUP BY there is exactly one group even when there are no rows:
  //the COUNT(*) of an empty table is a row saying 0, not an empty result
  if (groupExprs.length === 0 && groups.size === 0) groups.set('', start([]));

  const rows = [];
  for (const { values, states } of groups.values()) {
    rows.push([...values, ...states.map((state) => state.result())]);
  }
  yield* inBatches(rows);
}
