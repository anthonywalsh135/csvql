//the expression compiler. an expression tree is turned, once, into a tree of
//closures. evaluating it against a row is then a chain of plain function
//calls, with no walking of the tree and no switching on node types, which
//matters when the same expression runs a million times.
//
//sql logic has three values: true, false, and null for "unknown". a comparison
//with null is null, and AND and OR follow kleene's rules, so FALSE AND NULL is
//false while TRUE AND NULL is null.

import { converterFor } from '../csv/types.js';
import { ExecutionError } from '../errors.js';
import { FUNCTIONS } from './functions.js';
import { compareValues, describeValue, toText, truth } from './values.js';

//any type on either side: nulls are handled before test is called
function comparison(left, right, test) {
  return (row) => {
    const a = left(row);
    const b = right(row);
    return a === null || b === null ? null : test(a, b);
  };
}

function arithmetic(left, right, symbol, apply) {
  return (row) => {
    const a = left(row);
    const b = right(row);
    if (a === null || b === null) return null;
    if (typeof a !== 'number' || typeof b !== 'number') {
      const operands = `${describeValue(a)} and ${describeValue(b)}`;
      throw new ExecutionError(`cannot apply ${symbol} to ${operands}`);
    }
    return apply(a, b);
  };
}

//values of the same type are compared directly, and the general ordering is
//only consulted when the types differ
const ordered = (test) => (a, b) =>
  test(typeof a === typeof b ? (a > b) - (a < b) : compareValues(a, b));

function compileBinary(expr, compile) {
  const left = compile(expr.left);
  const right = compile(expr.right);
  switch (expr.op) {
    case 'AND':
      return (row) => {
        const a = truth(left(row));
        if (a === false) return false;
        const b = truth(right(row));
        if (b === false) return false;
        return a === null || b === null ? null : true;
      };
    case 'OR':
      return (row) => {
        const a = truth(left(row));
        if (a === true) return true;
        const b = truth(right(row));
        if (b === true) return true;
        return a === null || b === null ? null : false;
      };
    case '=':
      return comparison(left, right, (a, b) => a === b);
    case '<>':
      return comparison(left, right, (a, b) => a !== b);
    case '<':
      return comparison(
        left,
        right,
        ordered((order) => order < 0),
      );
    case '<=':
      return comparison(
        left,
        right,
        ordered((order) => order <= 0),
      );
    case '>':
      return comparison(
        left,
        right,
        ordered((order) => order > 0),
      );
    case '>=':
      return comparison(
        left,
        right,
        ordered((order) => order >= 0),
      );
    case '+':
      return arithmetic(left, right, '+', (a, b) => a + b);
    case '-':
      return arithmetic(left, right, '-', (a, b) => a - b);
    case '*':
      return arithmetic(left, right, '*', (a, b) => a * b);
    //dividing by zero gives null rather than an error or infinity, as in sqlite
    case '/':
      return arithmetic(left, right, '/', (a, b) => (b === 0 ? null : a / b));
    case '%':
      return arithmetic(left, right, '%', (a, b) => (b === 0 ? null : a % b));
    case '||':
      return comparison(left, right, (a, b) => toText(a) + toText(b));
    default:
      throw new Error(`unknown operator ${expr.op}`);
  }
}

function compileUnary(expr, compile) {
  const operand = compile(expr.operand);
  if (expr.op === 'NOT') {
    return (row) => {
      const value = truth(operand(row));
      return value === null ? null : !value;
    };
  }
  return (row) => {
    const value = operand(row);
    if (value === null) return null;
    if (typeof value !== 'number') {
      throw new ExecutionError(`cannot negate ${describeValue(value)}`);
    }
    return -value;
  };
}

//x IN (a, b) is x = a OR x = b, so a null in the list turns "no match" into
//"unknown". when the list is all constants it becomes a set, and each row
//costs one lookup however long the list is.
function compileIn(expr, compile) {
  const operand = compile(expr.operand);
  const finish = (found) => (found === null ? null : found !== expr.negated);

  if (expr.list.every((item) => item.type === 'literal')) {
    const constants = new Set(expr.list.map((item) => item.value));
    const missed = constants.delete(null) ? null : false;
    return (row) => {
      const value = operand(row);
      if (value === null) return null;
      return finish(constants.has(value) ? true : missed);
    };
  }

  const items = expr.list.map(compile);
  return (row) => {
    const value = operand(row);
    if (value === null) return null;
    let missed = false;
    for (const item of items) {
      const candidate = item(row);
      if (candidate === value) return finish(true);
      if (candidate === null) missed = null;
    }
    return finish(missed);
  };
}

function compileBetween(expr, compile) {
  const operand = compile(expr.operand);
  const low = compile(expr.low);
  const high = compile(expr.high);
  return (row) => {
    const value = operand(row);
    if (value === null) return null;
    const a = low(row);
    const b = high(row);
    //x >= a AND x <= b, where either half may be unknown
    const above = a === null ? null : compareValues(value, a) >= 0;
    const below = b === null ? null : compareValues(value, b) <= 0;
    if (above === false || below === false) return expr.negated;
    return above === null || below === null ? null : !expr.negated;
  };
}

//turns a LIKE pattern into a regular expression: % is any run of characters,
//_ is any one character, and everything else stands for itself. matching
//ignores case, as it does in sqlite and mysql.
function likeToRegExp(pattern) {
  let source = '';
  for (const ch of pattern) {
    if (ch === '%') source += '.*';
    else if (ch === '_') source += '.';
    else source += ch.replace(/[\\^$.*+?()[\]{}|/]/, '\\$&');
  }
  return new RegExp(`^${source}$`, 'isu');
}

function compileLike(expr, compile) {
  const operand = compile(expr.operand);
  const pattern = compile(expr.pattern);
  //the pattern is nearly always a constant, so the last one built is kept
  let builtFrom = null;
  let matcher = null;
  return (row) => {
    const value = operand(row);
    const like = pattern(row);
    if (value === null || like === null) return null;
    if (like !== builtFrom) {
      matcher = likeToRegExp(toText(like));
      builtFrom = like;
    }
    return matcher.test(toText(value)) !== expr.negated;
  };
}

function compileCase(expr, compile) {
  const branches = expr.branches.map(({ when, then }) => [compile(when), compile(then)]);
  const otherwise = expr.otherwise === null ? () => null : compile(expr.otherwise);

  if (expr.operand === null) {
    return (row) => {
      for (const [when, then] of branches) {
        if (truth(when(row)) === true) return then(row);
      }
      return otherwise(row);
    };
  }

  const operand = compile(expr.operand);
  return (row) => {
    const subject = operand(row);
    //a null subject equals nothing, itself included, so it falls to ELSE
    if (subject !== null) {
      for (const [when, then] of branches) {
        if (when(row) === subject) return then(row);
      }
    }
    return otherwise(row);
  };
}

function compileCall(expr, compile) {
  const { apply, acceptsNull = false } = FUNCTIONS.get(expr.name);
  const args = expr.args.map(compile);
  if (acceptsNull) return (row) => apply(...args.map((arg) => arg(row)));

  if (args.length === 1) {
    const [only] = args;
    return (row) => {
      const value = only(row);
      return value === null ? null : apply(value);
    };
  }
  return (row) => {
    const values = [];
    for (const arg of args) {
      const value = arg(row);
      if (value === null) return null;
      values.push(value);
    }
    return apply(...values);
  };
}

//text is read by the same rules as a field in a file, so CAST('12' AS INTEGER)
//and a column of integers agree on what a number looks like. text that cannot
//be read as the type becomes null.
function fromText(type, finish = (value) => value) {
  const convert = converterFor(type);
  return (text) => {
    const value = convert(text.trim());
    return typeof value === 'string' ? null : finish(value);
  };
}

//adding zero turns the -0 that truncating -0.5 leaves behind into a plain 0
const truncate = (value) => Math.trunc(value) + 0;

const CASTS = {
  integer: { number: truncate, boolean: Number, string: fromText('real', truncate) },
  real: { number: (value) => value, boolean: Number, string: fromText('real') },
  text: { number: String, boolean: String, string: (value) => value },
  boolean: {
    number: (value) => value !== 0,
    boolean: (value) => value,
    string: fromText('boolean'),
  },
};

function compileCast(expr, compile) {
  const operand = compile(expr.operand);
  const conversions = CASTS[expr.to];
  return (row) => {
    const value = operand(row);
    return value === null ? null : conversions[typeof value](value);
  };
}

//compiles an expression into a function from a row to a value. slotOf is asked
//once for each column in the expression and says where in the row to find it.
export function compileExpr(expr, slotOf) {
  const compile = (node) => compileExpr(node, slotOf);
  switch (expr.type) {
    case 'literal':
      return () => expr.value;
    case 'column': {
      const slot = slotOf(expr);
      return (row) => row[slot];
    }
    case 'binary':
      return compileBinary(expr, compile);
    case 'unary':
      return compileUnary(expr, compile);
    case 'is_null': {
      const operand = compile(expr.operand);
      return (row) => (operand(row) === null) !== expr.negated;
    }
    case 'in':
      return compileIn(expr, compile);
    case 'between':
      return compileBetween(expr, compile);
    case 'like':
      return compileLike(expr, compile);
    case 'case':
      return compileCase(expr, compile);
    case 'call':
      return compileCall(expr, compile);
    case 'cast':
      return compileCast(expr, compile);
    default:
      throw new Error(`cannot evaluate a ${expr.type} node`);
  }
}

//compiles an expression used as a condition. a row passes only when the
//expression is true, so false and unknown both reject it.
export function compileCondition(expr, slotOf) {
  const evaluate = compileExpr(expr, slotOf);
  return (row) => truth(evaluate(row)) === true;
}
