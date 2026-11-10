//turns an expression tree back into sql text. the text is used for the lines
//of a query plan, for naming aggregates, and as a key for deciding whether two
//expressions are the same one.

const LEVELS = { OR: 1, AND: 2, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '||': 7 };
const NOT = 3;
const COMPARISON = 4;
const SUM = 5;
const UNARY = 8;
const ATOM = 9;

//how tightly a node binds. a child that binds less tightly than its parent
//needs brackets around it to keep its meaning.
function levelOf(expr) {
  switch (expr.type) {
    case 'binary':
      return LEVELS[expr.op] ?? COMPARISON;
    case 'unary':
      return expr.op === 'NOT' ? NOT : UNARY;
    case 'is_null':
    case 'in':
    case 'between':
    case 'like':
      return COMPARISON;
    default:
      return ATOM;
  }
}

function formatLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  return String(value).toUpperCase();
}

const defaultName = (column) =>
  column.label ?? (column.table ? `${column.table}.${column.name}` : column.name);

//formats an expression as sql. nameColumn decides how a column is written,
//and defaults to the name the query knows it by.
export function formatExpr(expr, nameColumn = defaultName) {
  const format = (node) => formatExpr(node, nameColumn);
  const atLeast = (level, node) => (levelOf(node) < level ? `(${format(node)})` : format(node));
  const not = expr.negated ? 'NOT ' : '';

  switch (expr.type) {
    case 'literal':
      return formatLiteral(expr.value);
    case 'column':
      return nameColumn(expr);
    case 'unary':
      return expr.op === 'NOT'
        ? `NOT ${atLeast(NOT, expr.operand)}`
        : `-${atLeast(UNARY, expr.operand)}`;
    case 'binary': {
      const level = levelOf(expr);
      //operators group from the left, so only the right side needs brackets
      //when it is at the same level
      return `${atLeast(level, expr.left)} ${expr.op} ${atLeast(level + 1, expr.right)}`;
    }
    case 'is_null':
      return `${atLeast(SUM, expr.operand)} IS ${not}NULL`;
    case 'in':
      return `${atLeast(SUM, expr.operand)} ${not}IN (${expr.list.map(format).join(', ')})`;
    case 'between': {
      const bounds = `${atLeast(SUM, expr.low)} AND ${atLeast(SUM, expr.high)}`;
      return `${atLeast(SUM, expr.operand)} ${not}BETWEEN ${bounds}`;
    }
    case 'like':
      return `${atLeast(SUM, expr.operand)} ${not}LIKE ${atLeast(SUM, expr.pattern)}`;
    case 'case': {
      const parts = ['CASE'];
      if (expr.operand !== null) parts.push(format(expr.operand));
      for (const { when, then } of expr.branches) {
        parts.push(`WHEN ${format(when)} THEN ${format(then)}`);
      }
      if (expr.otherwise !== null) parts.push(`ELSE ${format(expr.otherwise)}`);
      return `${parts.join(' ')} END`;
    }
    case 'call':
      return `${expr.name}(${expr.star ? '*' : expr.args.map(format).join(', ')})`;
    case 'aggregate': {
      const arg = expr.arg === null ? '*' : format(expr.arg);
      return `${expr.func}(${expr.distinct ? 'DISTINCT ' : ''}${arg})`;
    }
    case 'cast':
      return `CAST(${format(expr.operand)} AS ${expr.to.toUpperCase()})`;
    default:
      throw new Error(`cannot format a ${expr.type} node`);
  }
}
