//joins. a joined row is the left row followed by the right row. for a left
//join, a left row with no partner is followed by nulls instead.

import { BATCH_SIZE, collect } from './batches.js';

//the general join: every left row is tried against every right row. it works
//for any condition, and costs the product of the two sizes.
export async function* nestedLoopJoin(left, right, { kind, condition, rightWidth }) {
  //the right side is read once and kept, then walked again for each left row
  const inner = await collect(right);
  const padding = new Array(rightWidth).fill(null);
  let joined = [];

  for await (const batch of left) {
    for (const outer of batch) {
      let matched = false;
      for (const row of inner) {
        const candidate = outer.concat(row);
        if (condition !== null && !condition(candidate)) continue;
        matched = true;
        joined.push(candidate);
        //one left row can match the whole right side, so the output is cut
        //into batches here and not once per input batch
        if (joined.length >= BATCH_SIZE) {
          yield joined;
          joined = [];
        }
      }
      if (!matched && kind === 'left') joined.push(outer.concat(padding));
    }
    if (joined.length > 0) {
      yield joined;
      joined = [];
    }
  }
}
