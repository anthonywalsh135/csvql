//column pruning. the plan is walked from the top down, carrying the set of
//columns that something higher up still needs. when the walk reaches a scan,
//the scan is told to read only those. a field nobody reads is never copied out
//of the file or converted, and that is most of what a scan spends its time on.

import { columnsIn } from '../expressions.js';
import { mapInputs, outputColumns } from '../nodes.js';

//the columns already needed, plus the ones these expressions read
function including(needed, exprs) {
  const all = new Set(needed);
  for (const expr of exprs) {
    if (expr !== null) columnsIn(expr, all);
  }
  return all;
}

function prune(node, needed) {
  switch (node.type) {
    case 'scan':
      return { ...node, columns: node.columns.filter((column) => needed.has(column.id)) };
    //a projection or an aggregate starts again: what it needs from below is
    //set by its own expressions, whatever is wanted from it above
    case 'project': {
      const exprs = node.items.map((item) => item.expr);
      return { ...node, input: prune(node.input, including([], exprs)) };
    }
    case 'aggregate': {
      const groupExprs = node.groups.map((group) => group.expr);
      const args = node.aggregates.map((entry) => entry.arg);
      return { ...node, input: prune(node.input, including([], [...groupExprs, ...args])) };
    }
    case 'filter':
      return { ...node, input: prune(node.input, including(needed, [node.predicate])) };
    case 'sort':
    case 'top-n': {
      const exprs = node.keys.map((key) => key.expr);
      return { ...node, input: prune(node.input, including(needed, exprs)) };
    }
    case 'join': {
      //ids are unique across the query, so each side simply ignores the ones
      //that belong to the other
      const all = including(needed, [node.condition]);
      return { ...node, left: prune(node.left, all), right: prune(node.right, all) };
    }
    default:
      return mapInputs(node, (input) => prune(input, needed));
  }
}

export function pruneColumns(plan) {
  return prune(plan, new Set(outputColumns(plan)));
}
