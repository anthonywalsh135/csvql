//renders a plan as a tree, one operator to a line, for EXPLAIN. the inputs of
//an operator are drawn beneath it, so the plan runs from the bottom up.

import { formatExpr } from '../sql/format.js';
import { inputsOf } from './nodes.js';

const keyList = (keys) =>
  keys.map(({ expr, descending }) => formatExpr(expr) + (descending ? ' DESC' : '')).join(', ');

function describeJoin(node) {
  if (node.kind === 'cross') return 'Cross join';
  const kind = node.kind === 'left' ? 'Left join' : 'Join';
  return node.condition === null ? kind : `${kind} on ${formatExpr(node.condition)}`;
}

function describe(node) {
  switch (node.type) {
    case 'scan': {
      const columns = node.columns.map((column) => column.name).join(', ') || 'no columns';
      const alias = node.alias === node.table.name ? '' : ` as ${node.alias}`;
      const rows = node.table.estimatedRows.toLocaleString('en-GB');
      return `Scan ${node.table.file}${alias} (${columns}) ~${rows} rows`;
    }
    case 'one-row':
      return 'One row';
    case 'filter':
      return `Filter ${formatExpr(node.predicate)}`;
    case 'join':
      return describeJoin(node);
    case 'aggregate': {
      const by =
        node.groups.length > 0 ? ` by ${node.groups.map((group) => group.label).join(', ')}` : '';
      const computed = node.aggregates.map((entry) => entry.label).join(', ');
      return `Aggregate${by}${computed === '' ? '' : `: ${computed}`}`;
    }
    case 'sort':
      return `Sort by ${keyList(node.keys)}`;
    case 'project': {
      const items = node.items.map(({ expr, name }) => {
        const text = formatExpr(expr);
        return text === name || expr.name === name ? text : `${text} AS ${name}`;
      });
      return `Project ${items.join(', ')}`;
    }
    case 'distinct':
      return 'Distinct';
    case 'limit':
      return `Limit ${node.limit}${node.offset > 0 ? ` offset ${node.offset}` : ''}`;
    default:
      throw new Error(`cannot describe a ${node.type} node`);
  }
}

function render(node, first, rest, note, lines) {
  lines.push(first + describe(node) + note(node));
  const inputs = inputsOf(node);
  inputs.forEach((input, index) => {
    const last = index === inputs.length - 1;
    render(input, rest + (last ? '└─ ' : '├─ '), rest + (last ? '   ' : '│  '), note, lines);
  });
  return lines;
}

//returns the plan as text. note, if given, is called with each node and its
//result is added to the end of that node's line.
export function explainPlan(plan, note = () => '') {
  return render(plan, '', '', note, []).join('\n');
}
