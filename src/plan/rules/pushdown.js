//predicate pushdown. a WHERE clause is written above the joins, but most of
//its conditions only look at one table, and can be applied to that table
//before the join instead of to every joined row after it. conditions that
//compare two tables become the join's own condition, which is what turns
//"FROM a, b WHERE a.x = b.x" from a cross product into a join.

import { columnsIn, conjoin, conjuncts } from '../expressions.js';
import { mapInputs, outputColumns } from '../nodes.js';

const isTrue = (expr) => expr.type === 'literal' && expr.value === true;

//the predicates that could go no lower end up in a filter above the node
function filterAbove(node, predicates) {
  const predicate = conjoin(predicates.filter((expr) => !isTrue(expr)));
  return predicate === null ? node : { type: 'filter', input: node, predicate };
}

//which input of a join an expression reads its columns from
function sideOf(expr, leftIds, rightIds) {
  const ids = [...columnsIn(expr)];
  const left = ids.some((id) => leftIds.has(id));
  const right = ids.some((id) => rightIds.has(id));
  if (left && right) return 'both';
  if (right) return 'right';
  return 'left';
}

function pushIntoJoin(join, predicates) {
  const leftIds = new Set(outputColumns(join.left));
  const rightIds = new Set(outputColumns(join.right));
  const side = (expr) => sideOf(expr, leftIds, rightIds);
  const toLeft = [];
  const toRight = [];
  const on = [];
  const above = [];

  if (join.kind === 'left') {
    //a left join keeps every left row whatever its condition says, so the two
    //sets of predicates cannot be mixed. from above, only one that reads the
    //left side alone can move: one that reads the right side also has to
    //judge the rows the join pads with nulls, which do not exist yet below
    //it. from ON, only one that reads the right side alone can move, where it
    //narrows what a left row can match without removing the left row.
    for (const expr of predicates) (side(expr) === 'left' ? toLeft : above).push(expr);
    for (const expr of conjuncts(join.condition)) {
      (side(expr) === 'right' ? toRight : on).push(expr);
    }
  } else {
    for (const expr of [...predicates, ...conjuncts(join.condition)]) {
      const target = { left: toLeft, right: toRight, both: on }[side(expr)];
      target.push(expr);
    }
  }

  const condition = conjoin(on);
  let { kind } = join;
  if (kind !== 'left') kind = condition === null ? 'cross' : 'inner';
  const left = push(join.left, toLeft);
  const right = push(join.right, toRight);
  return filterAbove({ ...join, kind, left, right, condition }, above);
}

function push(node, predicates) {
  if (node.type === 'filter') {
    return push(node.input, [...predicates, ...conjuncts(node.predicate)]);
  }
  if (node.type === 'join') return pushIntoJoin(node, predicates);
  //filters do not move past the other operators, but there may be joins
  //further down that have filters of their own to place
  return filterAbove(
    mapInputs(node, (input) => push(input, [])),
    predicates,
  );
}

export function pushDownPredicates(plan) {
  return push(plan, []);
}
