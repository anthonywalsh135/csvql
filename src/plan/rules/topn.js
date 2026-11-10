//limit pushdown. a LIMIT above a projection is moved below it: a projection
//neither adds nor removes rows, so the select list is then only computed for
//the rows that survive. a LIMIT that ends up directly on a sort merges with it
//into a top-n, which never needs to hold or order the whole input.

import { mapInputs } from '../nodes.js';

export function useTopN(plan) {
  const node = mapInputs(plan, useTopN);
  if (node.type !== 'limit') return node;
  const { input, limit, offset } = node;
  if (input.type === 'project') {
    return { ...input, input: useTopN({ ...node, input: input.input }) };
  }
  if (input.type === 'sort') {
    return { type: 'top-n', input: input.input, keys: input.keys, limit, offset };
  }
  return node;
}
