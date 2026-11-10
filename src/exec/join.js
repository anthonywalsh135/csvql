//joins. a joined row is the left row followed by the right row. for a left
//join, a left row with no partner is followed by nulls instead.

import { BATCH_SIZE, collect } from './batches.js';
import { encodeKey } from './values.js';

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

//the value a row is filed under in the hash table, or null if it can never
//match. null equals nothing, so a null in any key column rules the row out.
function hashKey(exprs, row) {
  if (exprs.length === 1) return exprs[0](row);
  const values = exprs.map((expr) => expr(row));
  return values.includes(null) ? null : encodeKey(values);
}

//joins on equality. one input is read into a hash table, then each row of the
//other is looked up in it. settings.build says which input the table is built
//from; the rows that come out are left then right either way.
export async function* hashJoin(left, right, settings) {
  const { kind, leftKeys, rightKeys, residual, rightWidth } = settings;
  const buildLeft = settings.build === 'left';
  const [buildKeys, probeKeys] = buildLeft ? [leftKeys, rightKeys] : [rightKeys, leftKeys];

  const table = new Map();
  for await (const batch of buildLeft ? left : right) {
    for (const row of batch) {
      const key = hashKey(buildKeys, row);
      if (key === null) continue;
      const bucket = table.get(key);
      if (bucket === undefined) table.set(key, [row]);
      else bucket.push(row);
    }
  }

  const padding = new Array(rightWidth).fill(null);
  let joined = [];
  for await (const batch of buildLeft ? right : left) {
    for (const probe of batch) {
      const key = hashKey(probeKeys, probe);
      const bucket = key === null ? undefined : table.get(key);
      let matched = false;
      for (const partner of bucket ?? []) {
        const candidate = buildLeft ? partner.concat(probe) : probe.concat(partner);
        if (residual !== null && !residual(candidate)) continue;
        matched = true;
        joined.push(candidate);
        if (joined.length >= BATCH_SIZE) {
          yield joined;
          joined = [];
        }
      }
      if (!matched && kind === 'left') joined.push(probe.concat(padding));
    }
    if (joined.length > 0) {
      yield joined;
      joined = [];
    }
  }
}
