//rough guesses at how many rows a node produces. the only decision that rests
//on them is which input of a hash join to build the table from, so they need
//to be in the right order far more than they need to be right. the fractions
//are the fixed ones system r used for a predicate it knew nothing about.

const EQUALITY = 1 / 10;
const RANGE = 1 / 3;
const UNKNOWN = 1 / 2;

function selectivity(expr) {
  if (expr.type === 'binary') {
    if (expr.op === 'AND') return selectivity(expr.left) * selectivity(expr.right);
    if (expr.op === 'OR') return Math.min(1, selectivity(expr.left) + selectivity(expr.right));
    if (expr.op === '=') return EQUALITY;
    if (expr.op === '<>') return 1 - EQUALITY;
    if (['<', '<=', '>', '>='].includes(expr.op)) return RANGE;
  }
  if (expr.type === 'unary' && expr.op === 'NOT') return 1 - selectivity(expr.operand);
  if (expr.type === 'in') return Math.min(1, expr.list.length * EQUALITY);
  if (expr.type === 'is_null') return expr.negated ? 1 - EQUALITY : EQUALITY;
  if (expr.type === 'between' || expr.type === 'like') return RANGE;
  return UNKNOWN;
}

export function estimateRows(node) {
  switch (node.type) {
    case 'scan':
      return node.table.estimatedRows;
    case 'one-row':
      return 1;
    case 'filter':
      return estimateRows(node.input) * selectivity(node.predicate);
    case 'join': {
      const left = estimateRows(node.left);
      const right = estimateRows(node.right);
      //with a condition, assume each row of the larger side finds one partner
      return node.condition === null ? left * right : Math.max(left, right);
    }
    case 'aggregate':
      return node.groups.length === 0 ? 1 : estimateRows(node.input) * EQUALITY;
    case 'limit':
    case 'top-n':
      return Math.min(node.limit, estimateRows(node.input));
    default:
      return estimateRows(node.input);
  }
}
