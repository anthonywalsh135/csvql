//join strategy. when a join's condition contains an equality between its two
//sides, the join can be done with a hash table: one side is read into a table
//keyed on its half of the equality, and each row of the other side looks its
//partners up directly. that costs the two inputs added together, where trying
//every pair costs their product.

import { estimateRows } from '../estimate.js';
import { columnsIn, conjoin, conjuncts } from '../expressions.js';
import { mapInputs, outputColumns } from '../nodes.js';

//an expression can be a hash key for a side if every column in it comes from
//that side. one with no columns at all belongs to neither.
function readsOnly(expr, ids) {
  const columns = [...columnsIn(expr)];
  return columns.length > 0 && columns.every((id) => ids.has(id));
}

export function chooseJoinStrategies(plan) {
  const node = mapInputs(plan, chooseJoinStrategies);
  if (node.type !== 'join' || node.condition === null) return node;

  const leftIds = new Set(outputColumns(node.left));
  const rightIds = new Set(outputColumns(node.right));
  const leftKeys = [];
  const rightKeys = [];
  const residual = [];
  for (const expr of conjuncts(node.condition)) {
    const isEquality = expr.type === 'binary' && expr.op === '=';
    if (isEquality && readsOnly(expr.left, leftIds) && readsOnly(expr.right, rightIds)) {
      leftKeys.push(expr.left);
      rightKeys.push(expr.right);
    } else if (isEquality && readsOnly(expr.left, rightIds) && readsOnly(expr.right, leftIds)) {
      leftKeys.push(expr.right);
      rightKeys.push(expr.left);
    } else {
      //anything else is checked on each pair the hash table brings together
      residual.push(expr);
    }
  }
  if (leftKeys.length === 0) return node;

  //the table is built from the smaller input, as it is the one held in memory.
  //a left join has no choice: left rows without a partner have to be noticed
  //as they go past, so the table must be the right side.
  const buildLeft = node.kind !== 'left' && estimateRows(node.left) < estimateRows(node.right);
  return {
    ...node,
    strategy: 'hash',
    leftKeys,
    rightKeys,
    residual: conjoin(residual),
    build: buildLeft ? 'left' : 'right',
  };
}
