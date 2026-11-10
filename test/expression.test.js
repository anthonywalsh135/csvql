import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ExecutionError } from '../src/errors.js';
import { compileCondition, compileExpr } from '../src/exec/expression.js';
import { parseExpression } from '../src/sql/parser.js';

//evaluates an expression against a row given as { column: value }
function evaluate(sql, row = {}) {
  const names = Object.keys(row);
  const run = compileExpr(parseExpression(sql), (column) => names.indexOf(column.name));
  return run(Object.values(row));
}

function fails(sql, message, row) {
  assert.throws(
    () => evaluate(sql, row),
    (error) => error instanceof ExecutionError && message.test(error.message),
    `${sql} should fail with ${message}`,
  );
}

//checks a list of [expression, expected value] pairs
function table(cases, row) {
  for (const [sql, expected] of cases) {
    assert.deepEqual(evaluate(sql, row), expected, sql);
  }
}

test('arithmetic follows the usual rules', () => {
  table([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 - 4 - 3', 3],
    ['7 % 3', 1],
    ['-7 % 3', -1],
    ['2 * -3', -6],
    ['-(2 + 3)', -5],
    ['0.1 + 0.2', 0.1 + 0.2],
  ]);
});

test('division is always real division, and dividing by zero is null', () => {
  table([
    ['7 / 2', 3.5],
    ['6 / 3', 2],
    ['1 / 0', null],
    ['1 % 0', null],
    ['0 / 5', 0],
  ]);
});

test('null spreads through arithmetic, comparison and concatenation', () => {
  table(
    [
      ['1 + NULL', null],
      ['NULL * 0', null],
      ['-x', null],
      ['x = 1', null],
      ['x = x', null],
      ['x <> 1', null],
      ['x < 1', null],
      ["'a' || x", null],
    ],
    { x: null },
  );
});

test('arithmetic on anything but numbers is an error that names the values', () => {
  fails("1 + 'a'", /cannot apply \+ to the number 1 and the text 'a'/);
  fails("'10' * 2", /cannot apply \* to the text '10' and the number 2/);
  fails('TRUE - 1', /cannot apply - to the boolean true and the number 1/);
  fails("-'a'", /cannot negate the text 'a'/);
});

test('concatenation turns numbers and booleans into text', () => {
  table([
    ["'a' || 'b' || 'c'", 'abc'],
    ["'n=' || 42", 'n=42'],
    ['1 || 2', '12'],
    ["1.5 || ''", '1.5'],
    ["TRUE || '!'", 'true!'],
  ]);
});

test('values of the same type compare the natural way', () => {
  table([
    ['2 < 10', true],
    ['2 >= 2', true],
    ['2.5 > 2', true],
    ['1 = 1.0', true],
    ['1 <> 2', true],
    ["'apple' < 'banana'", true],
    ["'Zebra' < 'apple'", true],
    ["'a' = 'A'", false],
    ["'10' < '9'", true],
    ['FALSE < TRUE', true],
    ['TRUE = TRUE', true],
  ]);
});

test('values of different types are ordered by type and are never equal', () => {
  table([
    ["10 < '9'", true],
    ["1 = '1'", false],
    ["1 <> '1'", true],
    ['TRUE < 0', true],
    ['TRUE = 1', false],
    ["'a' > 1000000", true],
    ["TRUE >= 'a'", false],
  ]);
});

test('AND, OR and NOT follow three-valued logic', () => {
  const T = true;
  const F = false;
  const N = null;
  const inputs = [T, F, N];
  const and = [
    [T, F, N],
    [F, F, F],
    [N, F, N],
  ];
  const or = [
    [T, T, T],
    [T, F, N],
    [T, N, N],
  ];
  inputs.forEach((a, i) => {
    inputs.forEach((b, j) => {
      assert.equal(evaluate('a AND b', { a, b }), and[i][j], `${a} AND ${b}`);
      assert.equal(evaluate('a OR b', { a, b }), or[i][j], `${a} OR ${b}`);
    });
  });
  assert.deepEqual(
    inputs.map((a) => evaluate('NOT a', { a })),
    [F, T, N],
  );
});

test('AND and OR stop as soon as the answer is known', () => {
  //the right-hand side would fail if it were evaluated
  assert.equal(evaluate("FALSE AND 1 + 'a' > 0"), false);
  assert.equal(evaluate("TRUE OR 1 + 'a' > 0"), true);
});

test('numbers can stand in for conditions, text cannot', () => {
  table([
    ['1 AND 2', true],
    ['0 OR 0.0', false],
    ['NOT 5', false],
    ['NOT 0', true],
  ]);
  fails("'yes' AND TRUE", /expected a condition but got the text 'yes'/);
});

test('IS NULL and IS NOT NULL always give true or false', () => {
  table(
    [
      ['x IS NULL', true],
      ['x IS NOT NULL', false],
      ['y IS NULL', false],
      ['y IS NOT NULL', true],
      ['(x = 1) IS NULL', true],
    ],
    { x: null, y: 0 },
  );
});

test('IN against a list of constants', () => {
  table([
    ['2 IN (1, 2, 3)', true],
    ['5 IN (1, 2, 3)', false],
    ['5 NOT IN (1, 2, 3)', true],
    ['2 NOT IN (1, 2, 3)', false],
    ["'b' IN ('a', 'b')", true],
    ["1 IN ('1', 2)", false],
    ['NULL IN (1, 2)', null],
    ['NULL NOT IN (1, 2)', null],
  ]);
});

test('a null in the list makes a miss unknown, but a hit is still a hit', () => {
  table([
    ['1 IN (1, NULL)', true],
    ['2 IN (1, NULL)', null],
    ['1 NOT IN (1, NULL)', false],
    ['2 NOT IN (1, NULL)', null],
  ]);
});

test('IN against a list with columns in it behaves the same way', () => {
  const row = { a: 1, b: 2, n: null };
  table(
    [
      ['2 IN (a, b)', true],
      ['3 IN (a, b)', false],
      ['3 NOT IN (a, b)', true],
      ['1 IN (n, a)', true],
      ['3 IN (a, n)', null],
      ['3 NOT IN (a, n)', null],
      ['n IN (a, b)', null],
      ['a + 1 IN (b * 1, 10)', true],
    ],
    row,
  );
});

test('BETWEEN includes both ends', () => {
  table([
    ['5 BETWEEN 1 AND 10', true],
    ['1 BETWEEN 1 AND 10', true],
    ['10 BETWEEN 1 AND 10', true],
    ['11 BETWEEN 1 AND 10', false],
    ['5 NOT BETWEEN 1 AND 10', false],
    ['0 NOT BETWEEN 1 AND 10', true],
    ["'b' BETWEEN 'a' AND 'c'", true],
    ['5 BETWEEN 10 AND 1', false],
  ]);
});

test('BETWEEN with an unknown bound is unknown unless the other bound decides it', () => {
  table([
    ['NULL BETWEEN 1 AND 2', null],
    ['5 BETWEEN NULL AND 10', null],
    ['5 BETWEEN 1 AND NULL', null],
    ['50 BETWEEN NULL AND 10', false],
    ['0 BETWEEN 1 AND NULL', false],
    ['50 NOT BETWEEN NULL AND 10', true],
    ['5 NOT BETWEEN NULL AND 10', null],
  ]);
});

test('LIKE matches % and _ and ignores case', () => {
  table([
    ["'Southampton' LIKE 'south%'", true],
    ["'Southampton' LIKE '%AMP%'", true],
    ["'Southampton' LIKE '%ton'", true],
    ["'Southampton' LIKE 'south'", false],
    ["'cat' LIKE 'c_t'", true],
    ["'cart' LIKE 'c_t'", false],
    ["'' LIKE '%'", true],
    ["'' LIKE '_'", false],
    ["'abc' NOT LIKE 'a%'", false],
    ["'abc' NOT LIKE 'b%'", true],
    ["'two\nlines' LIKE 'two%lines'", true],
    ["'😀' LIKE '_'", true],
  ]);
});

test('characters that are special in a regular expression are ordinary in LIKE', () => {
  table([
    ["'a.c' LIKE 'a.c'", true],
    ["'abc' LIKE 'a.c'", false],
    ["'1+1=2 (ok) [x] {y} ^$ a|b \\ /' LIKE '1+1=2 (ok) [x] {y} ^$ a|b \\ /'", true],
    ["'50% off' LIKE '50%'", true],
    ["'a*' LIKE 'a*'", true],
    ["'aaa' LIKE 'a*'", false],
  ]);
});

test('LIKE reads numbers as text, and null stays null', () => {
  table(
    [
      ["2026 LIKE '20%'", true],
      ["name LIKE 'a%'", null],
      ["'abc' LIKE name", null],
    ],
    { name: null },
  );
});

test('a LIKE pattern can come from the row', () => {
  const sql = 'word LIKE pattern';
  assert.equal(evaluate(sql, { word: 'hello', pattern: 'h%' }), true);
  const names = ['word', 'pattern'];
  const run = compileExpr(parseExpression(sql), (column) => names.indexOf(column.name));
  assert.deepEqual(
    [
      ['hello', 'h%'],
      ['hello', 'x%'],
      ['xylem', 'x%'],
      ['hello', 'h%'],
    ].map(run),
    [true, false, true, true],
  );
});

test('searched CASE takes the first branch whose condition is true', () => {
  const sql =
    "CASE WHEN n < 0 THEN 'negative' WHEN n = 0 THEN 'zero' WHEN n < 10 THEN 'small' ELSE 'large' END";
  assert.equal(evaluate(sql, { n: -5 }), 'negative');
  assert.equal(evaluate(sql, { n: 0 }), 'zero');
  assert.equal(evaluate(sql, { n: 7 }), 'small');
  assert.equal(evaluate(sql, { n: 70 }), 'large');
  assert.equal(evaluate(sql, { n: null }), 'large', 'an unknown condition is not taken');
  assert.equal(evaluate('CASE WHEN n > 100 THEN 1 END', { n: 1 }), null, 'no ELSE means null');
});

test('simple CASE compares its subject with each WHEN', () => {
  const sql = "CASE code WHEN 1 THEN 'one' WHEN 2 THEN 'two' ELSE 'many' END";
  assert.equal(evaluate(sql, { code: 1 }), 'one');
  assert.equal(evaluate(sql, { code: 2 }), 'two');
  assert.equal(evaluate(sql, { code: 3 }), 'many');
  assert.equal(
    evaluate("CASE code WHEN NULL THEN 'null' ELSE 'other' END", { code: null }),
    'other',
  );
  assert.equal(evaluate("CASE code WHEN 1 THEN 'one' END", { code: 9 }), null);
});

test('only the branch that is taken is evaluated', () => {
  assert.equal(evaluate("CASE WHEN TRUE THEN 1 ELSE 1 + 'a' END"), 1);
});

test('text functions', () => {
  table([
    ["UPPER('abc')", 'ABC'],
    ["LOWER('ABC')", 'abc'],
    ["LENGTH('héllo')", 5],
    ["LENGTH('😀!')", 2],
    ['LENGTH(12345)', 5],
    ["TRIM('  a b  ')", 'a b'],
    ["REPLACE('a-b-c', '-', '+')", 'a+b+c'],
    ["REPLACE('abc', '', 'x')", 'abc'],
    ["REPLACE('aaa', 'a', '')", ''],
    ['UPPER(NULL)', null],
    ["REPLACE('abc', NULL, 'x')", null],
  ]);
});

test('SUBSTR counts characters from 1, or from the end when negative', () => {
  table([
    ["SUBSTR('hello', 2)", 'ello'],
    ["SUBSTR('hello', 2, 3)", 'ell'],
    ["SUBSTR('hello', 1, 1)", 'h'],
    ["SUBSTR('hello', -3)", 'llo'],
    ["SUBSTR('hello', -3, 2)", 'll'],
    ["SUBSTR('hello', 10)", ''],
    ["SUBSTR('hello', 2, 0)", ''],
    ["SUBSTR('hello', 2, -1)", ''],
    ["SUBSTR('2026-11-10', 1, 4)", '2026'],
    ["SUBSTR('a😀b', 2, 1)", '😀'],
    ['SUBSTR(123456, 2, 2)', '23'],
  ]);
  fails("SUBSTR('hello', 'x')", /SUBSTR expects a number/);
});

test('numeric functions', () => {
  table([
    ['ABS(-5)', 5],
    ['ABS(2.5)', 2.5],
    ['FLOOR(2.7)', 2],
    ['FLOOR(-2.1)', -3],
    ['CEIL(2.1)', 3],
    ['CEIL(-2.7)', -2],
    ['ABS(NULL)', null],
  ]);
  fails("ABS('x')", /ABS expects a number but got the text 'x'/);
});

test('ROUND rounds halves away from zero, at any number of places', () => {
  table([
    ['ROUND(2.5)', 3],
    ['ROUND(-2.5)', -3],
    ['ROUND(2.4)', 2],
    ['ROUND(-0.4)', 0],
    ['ROUND(3.14159, 2)', 3.14],
    ['ROUND(1.005, 2)', 1.01],
    ['ROUND(2.675, 2)', 2.68],
    ['ROUND(-1.005, 2)', -1.01],
    ['ROUND(1234.5678, -2)', 1200],
    ['ROUND(5, 2)', 5],
    ['ROUND(1e21, 2)', 1e21],
    ['ROUND(0.0000001, 2)', 0],
    ['ROUND(NULL, 2)', null],
  ]);
  assert.ok(Object.is(evaluate('ROUND(-0.4)'), 0), 'no negative zero');
});

test('COALESCE, IFNULL and NULLIF', () => {
  table([
    ["COALESCE(NULL, NULL, 'x', 'y')", 'x'],
    ['COALESCE(NULL, NULL)', null],
    ['COALESCE(0, 1)', 0],
    ['IFNULL(NULL, 5)', 5],
    ['IFNULL(4, 5)', 4],
    ['NULLIF(5, 5)', null],
    ['NULLIF(5, 6)', 5],
    ['NULLIF(NULL, 5)', null],
    ["NULLIF(5, '5')", 5],
  ]);
});

test('CAST converts between the four types', () => {
  table([
    ['CAST(3.9 AS INTEGER)', 3],
    ['CAST(-3.9 AS INTEGER)', -3],
    ["CAST('42' AS INTEGER)", 42],
    ["CAST(' 7.8 ' AS INTEGER)", 7],
    ['CAST(TRUE AS INTEGER)', 1],
    ["CAST('1.5e2' AS REAL)", 150],
    ['CAST(2 AS REAL)', 2],
    ['CAST(FALSE AS REAL)', 0],
    ['CAST(42 AS TEXT)', '42'],
    ['CAST(1.5 AS TEXT)', '1.5'],
    ['CAST(TRUE AS TEXT)', 'true'],
    ["CAST('x' AS TEXT)", 'x'],
    ['CAST(0 AS BOOLEAN)', false],
    ['CAST(-2 AS BOOLEAN)', true],
    ["CAST('TRUE' AS BOOLEAN)", true],
    ['CAST(FALSE AS BOOLEAN)', false],
    ['CAST(NULL AS INTEGER)', null],
  ]);
  assert.ok(Object.is(evaluate('CAST(-0.5 AS INTEGER)'), 0), 'no negative zero');
});

test('CAST gives null for text that cannot be read as the type', () => {
  table([
    ["CAST('abc' AS INTEGER)", null],
    ["CAST('' AS REAL)", null],
    ["CAST('12 apples' AS INTEGER)", null],
    ["CAST('yes' AS BOOLEAN)", null],
  ]);
});

test('columns are read from the slot the caller gives', () => {
  assert.equal(evaluate('price * quantity', { quantity: 3, price: 2.5 }), 7.5);
  assert.equal(evaluate("UPPER(name) || '!'", { name: 'ada' }), 'ADA!');
});

test('a condition passes only when it is true', () => {
  const passes = (sql, row = {}) => {
    const names = Object.keys(row);
    return compileCondition(parseExpression(sql), (column) => names.indexOf(column.name))(
      Object.values(row),
    );
  };
  assert.equal(passes('x > 1', { x: 2 }), true);
  assert.equal(passes('x > 1', { x: 1 }), false);
  assert.equal(passes('x > 1', { x: null }), false, 'unknown rejects the row');
  assert.equal(passes('NOT x > 1', { x: null }), false, 'and so does its negation');
  assert.equal(passes('x', { x: 3 }), true);
  assert.equal(passes('x', { x: 0 }), false);
  assert.throws(() => passes("'text'"), ExecutionError);
});
