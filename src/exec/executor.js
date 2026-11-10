//turns a plan into something that runs. each node becomes an async generator
//that pulls batches of rows from the generators of the nodes beneath it, so
//rows flow up the tree a batch at a time and nothing is read until whoever is
//at the top asks for it.
//
//this is also where a column's id finally becomes a position in a row. each
//node is built knowing the layout of its input, and its expressions are
//compiled against that layout.

import { outputColumns } from '../plan/nodes.js';
import { compileCondition, compileExpr } from './expression.js';
import { aggregate } from './group.js';
import { hashJoin, nestedLoopJoin } from './join.js';
import { distinct, filter, limit, project, scan } from './operators.js';
import { sort } from './sort.js';

//a function that tells the expression compiler where in a row a column is
function slotsOf(ids) {
  return (column) => {
    const slot = ids.indexOf(column.id);
    if (slot === -1) throw new Error(`column ${column.label} is not available at this node`);
    return slot;
  };
}

async function* oneRow() {
  yield [[]];
}

//builds one node. returns the ids of the columns in its rows and a function
//that starts it running.
function build(node, options) {
  if (node.type === 'scan') {
    return { ids: outputColumns(node), open: () => scan(node, options.chunkSize) };
  }
  if (node.type === 'one-row') return { ids: [], open: oneRow };

  if (node.type === 'join') {
    const left = build(node.left, options);
    const right = build(node.right, options);
    const ids = [...left.ids, ...right.ids];
    const condition = (expr) => (expr === null ? null : compileCondition(expr, slotsOf(ids)));
    const shared = { kind: node.kind, rightWidth: right.ids.length };
    if (node.strategy === 'hash') {
      const settings = {
        ...shared,
        build: node.build,
        //each side's keys are worked out from that side's rows alone
        leftKeys: node.leftKeys.map((key) => compileExpr(key, slotsOf(left.ids))),
        rightKeys: node.rightKeys.map((key) => compileExpr(key, slotsOf(right.ids))),
        residual: condition(node.residual),
      };
      return { ids, open: () => hashJoin(left.open(), right.open(), settings) };
    }
    const settings = { ...shared, condition: condition(node.condition) };
    return { ids, open: () => nestedLoopJoin(left.open(), right.open(), settings) };
  }

  const input = build(node.input, options);
  const slots = slotsOf(input.ids);
  switch (node.type) {
    case 'filter': {
      const predicate = compileCondition(node.predicate, slots);
      return { ids: input.ids, open: () => filter(input.open(), predicate) };
    }
    case 'project': {
      const exprs = node.items.map((item) => compileExpr(item.expr, slots));
      return { ids: outputColumns(node), open: () => project(input.open(), exprs) };
    }
    case 'aggregate': {
      const groups = node.groups.map((group) => compileExpr(group.expr, slots));
      const aggregates = node.aggregates.map(({ func, distinct: isDistinct, arg }) => ({
        func,
        distinct: isDistinct,
        arg: arg === null ? null : compileExpr(arg, slots),
      }));
      return { ids: outputColumns(node), open: () => aggregate(input.open(), groups, aggregates) };
    }
    case 'sort': {
      const keys = node.keys.map(({ expr, descending }) => ({
        value: compileExpr(expr, slots),
        descending,
      }));
      return { ids: input.ids, open: () => sort(input.open(), keys) };
    }
    case 'distinct':
      return { ids: input.ids, open: () => distinct(input.open()) };
    case 'limit':
      return { ids: input.ids, open: () => limit(input.open(), node.limit, node.offset) };
    default:
      throw new Error(`cannot execute a ${node.type} node`);
  }
}

//runs a plan and returns its result as an async iterable of batches of rows
export function execute(plan, options = {}) {
  return build(plan, options).open();
}
