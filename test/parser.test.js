import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqlSyntaxError } from '../src/errors.js';
import { parse, parseExpression, parseScript } from '../src/sql/parser.js';

//a fully bracketed rendering of an expression tree, so that a test can show
//how something was grouped without spelling out nested objects
function show(expr) {
  const not = expr.negated ? 'not-' : '';
  switch (expr.type) {
    case 'literal':
      if (expr.value === null) return 'NULL';
      return typeof expr.value === 'string' ? `'${expr.value}'` : String(expr.value);
    case 'column':
      return expr.table ? `${expr.table}.${expr.name}` : expr.name;
    case 'unary':
      return `(${expr.op} ${show(expr.operand)})`;
    case 'binary':
      return `(${expr.op} ${show(expr.left)} ${show(expr.right)})`;
    case 'is_null':
      return `(${not}null ${show(expr.operand)})`;
    case 'in':
      return `(${not}in ${show(expr.operand)} [${expr.list.map(show).join(' ')}])`;
    case 'between':
      return `(${not}between ${show(expr.operand)} ${show(expr.low)} ${show(expr.high)})`;
    case 'like':
      return `(${not}like ${show(expr.operand)} ${show(expr.pattern)})`;
    case 'cast':
      return `(cast ${show(expr.operand)} ${expr.to})`;
    case 'call': {
      const args = expr.star ? ['*'] : expr.args.map(show);
      return `(${[expr.name, ...(expr.distinct ? ['distinct'] : []), ...args].join(' ')})`;
    }
    case 'case': {
      const parts = expr.operand ? [show(expr.operand)] : [];
      for (const branch of expr.branches) parts.push(`${show(branch.when)}=>${show(branch.then)}`);
      if (expr.otherwise) parts.push(`else=>${show(expr.otherwise)}`);
      return `(case ${parts.join(' ')})`;
    }
    default:
      throw new Error(`unexpected node ${expr.type}`);
  }
}

const grouped = (sql) => show(parseExpression(sql));

function syntaxError(run, message, position) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof SqlSyntaxError, `expected a syntax error, got ${error}`);
    assert.match(error.message, message);
    if (position !== undefined) assert.equal(error.position, position);
    return true;
  });
}

test('multiplication binds tighter than addition', () => {
  assert.equal(grouped('1 + 2 * 3'), '(+ 1 (* 2 3))');
  assert.equal(grouped('1 * 2 + 3'), '(+ (* 1 2) 3)');
  assert.equal(grouped('10 % 4 - 6 / 3'), '(- (% 10 4) (/ 6 3))');
});

test('operators of the same level group from the left', () => {
  assert.equal(grouped('8 - 3 - 2'), '(- (- 8 3) 2)');
  assert.equal(grouped('8 / 4 / 2'), '(/ (/ 8 4) 2)');
  assert.equal(grouped("a || b || 'c'"), "(|| (|| a b) 'c')");
});

test('brackets override precedence', () => {
  assert.equal(grouped('(1 + 2) * 3'), '(* (+ 1 2) 3)');
  assert.equal(grouped('((a))'), 'a');
});

test('AND binds tighter than OR, and NOT tighter than both', () => {
  assert.equal(grouped('a OR b AND c'), '(OR a (AND b c))');
  assert.equal(grouped('NOT a AND b'), '(AND (NOT a) b)');
  assert.equal(grouped('NOT a = b'), '(NOT (= a b))');
  assert.equal(grouped('NOT NOT a'), '(NOT (NOT a))');
});

test('comparisons sit between arithmetic and the logical operators', () => {
  assert.equal(grouped('a + 1 > b * 2 AND c'), '(AND (> (+ a 1) (* b 2)) c)');
  assert.equal(grouped('a != b'), '(<> a b)');
  assert.equal(grouped('a <> b'), '(<> a b)');
  assert.equal(grouped('a <= b'), '(<= a b)');
});

test('concatenation binds tighter than arithmetic', () => {
  assert.equal(grouped('1 + 2 || 3'), '(+ 1 (|| 2 3))');
});

test('a minus sign in front of a number makes a negative literal', () => {
  assert.deepEqual(parseExpression('-5'), { type: 'literal', value: -5 });
  assert.equal(grouped('3 - -5'), '(- 3 -5)');
  assert.equal(grouped('-x * 2'), '(* (- x) 2)');
  assert.equal(grouped('+x'), 'x');
});

test('literals keep their type', () => {
  assert.deepEqual(parseExpression('TRUE'), { type: 'literal', value: true });
  assert.deepEqual(parseExpression('false'), { type: 'literal', value: false });
  assert.deepEqual(parseExpression('NULL'), { type: 'literal', value: null });
  assert.deepEqual(parseExpression("'42'"), { type: 'literal', value: '42' });
});

test('IS NULL and IS NOT NULL', () => {
  assert.equal(grouped('a IS NULL'), '(null a)');
  assert.equal(grouped('a + 1 IS NOT NULL OR b'), '(OR (not-null (+ a 1)) b)');
});

test('IN takes a list of expressions', () => {
  assert.equal(grouped("x IN (1, 2 + 3, 'a')"), "(in x [1 (+ 2 3) 'a'])");
  assert.equal(grouped('x NOT IN (1)'), '(not-in x [1])');
});

test('the AND inside BETWEEN belongs to it', () => {
  assert.equal(grouped('x BETWEEN 1 AND 10 AND y'), '(AND (between x 1 10) y)');
  assert.equal(grouped('x NOT BETWEEN a + 1 AND b'), '(not-between x (+ a 1) b)');
});

test('LIKE and NOT LIKE', () => {
  assert.equal(
    grouped("name LIKE 'A%' OR name NOT LIKE '%z'"),
    "(OR (like name 'A%') (not-like name '%z'))",
  );
});

test('both forms of CASE', () => {
  assert.equal(
    grouped("CASE WHEN a > 1 THEN 'big' WHEN a > 0 THEN 'small' ELSE 'none' END"),
    "(case (> a 1)=>'big' (> a 0)=>'small' else=>'none')",
  );
  assert.equal(grouped("CASE a WHEN 1 THEN 'one' END"), "(case a 1=>'one')");
});

test('CAST accepts the common names for each type', () => {
  assert.equal(grouped('CAST(a AS INTEGER)'), '(cast a integer)');
  assert.equal(grouped('CAST(a AS int)'), '(cast a integer)');
  assert.equal(grouped('CAST(a AS double)'), '(cast a real)');
  assert.equal(grouped('CAST(a + 1 AS varchar)'), '(cast (+ a 1) text)');
  assert.equal(grouped('CAST(a AS bool)'), '(cast a boolean)');
});

test('function calls, including COUNT(*) and DISTINCT', () => {
  assert.equal(grouped('upper(name)'), '(UPPER name)');
  assert.equal(grouped('ROUND(AVG(price), 2)'), '(ROUND (AVG price) 2)');
  assert.equal(grouped('COUNT(*)'), '(COUNT *)');
  assert.equal(grouped('COUNT(DISTINCT city)'), '(COUNT distinct city)');
  assert.equal(grouped('f()'), '(F)');
});

test('columns can be qualified and quoted', () => {
  assert.deepEqual(parseExpression('t.price'), {
    type: 'column',
    table: 't',
    name: 'price',
    pos: 0,
  });
  assert.equal(grouped('"first name"'), 'first name');
  assert.equal(grouped('o.[unit price] * 2'), '(* o.unit price 2)');
});

test('a minimal query', () => {
  const { explain, select } = parse('SELECT 1');
  assert.equal(explain, null);
  assert.deepEqual(select, {
    distinct: false,
    columns: [{ type: 'expr', expr: { type: 'literal', value: 1 }, alias: null, text: '1' }],
    from: null,
    joins: [],
    where: null,
    groupBy: [],
    having: null,
    orderBy: [],
    limit: null,
    offset: 0,
  });
});

test('every clause of a full query lands in the right place', () => {
  const { select } = parse(`
    SELECT DISTINCT c.country, COUNT(*) AS orders
    FROM orders o
    JOIN customers AS c ON o.customer_id = c.id
    WHERE o.status = 'shipped'
    GROUP BY c.country
    HAVING COUNT(*) > 10
    ORDER BY orders DESC, c.country
    LIMIT 5 OFFSET 10;
  `);
  assert.equal(select.distinct, true);
  assert.deepEqual(
    select.columns.map((column) => [show(column.expr), column.alias]),
    [
      ['c.country', null],
      ['(COUNT *)', 'orders'],
    ],
  );
  assert.deepEqual(select.from, { name: 'orders', isPath: false, alias: 'o', pos: 60 });
  assert.equal(select.joins.length, 1);
  assert.equal(select.joins[0].kind, 'inner');
  assert.equal(select.joins[0].table.alias, 'c');
  assert.equal(show(select.joins[0].on), '(= o.customer_id c.id)');
  assert.equal(show(select.where), "(= o.status 'shipped')");
  assert.deepEqual(select.groupBy.map(show), ['c.country']);
  assert.equal(show(select.having), '(> (COUNT *) 10)');
  assert.deepEqual(
    select.orderBy.map((item) => [show(item.expr), item.descending]),
    [
      ['orders', true],
      ['c.country', false],
    ],
  );
  assert.equal(select.limit, 5);
  assert.equal(select.offset, 10);
});

test('select items can be stars, and aliases do not need AS', () => {
  const { select } = parse('SELECT *, t.*, price * 2 double, name AS "full name" FROM t');
  assert.deepEqual(
    select.columns.map((column) => column.type),
    ['star', 'star', 'expr', 'expr'],
  );
  assert.equal(select.columns[0].table, null);
  assert.equal(select.columns[1].table, 't');
  assert.equal(select.columns[2].alias, 'double');
  assert.equal(select.columns[3].alias, 'full name');
});

test('a select item remembers the text it was written as', () => {
  const { select } = parse('SELECT  price *\n  quantity , upper( name ) AS n FROM t');
  assert.deepEqual(
    select.columns.map((column) => column.text),
    ['price * quantity', 'upper( name )'],
  );
});

test('a table can be a bare name or a quoted path', () => {
  const { select } = parse("SELECT * FROM 'data/2026/sales.csv' AS s");
  assert.deepEqual(select.from, { name: 'data/2026/sales.csv', isPath: true, alias: 's', pos: 14 });
});

test('every kind of join', () => {
  const { select } = parse(`
    SELECT * FROM a
    JOIN b ON a.x = b.x
    INNER JOIN c ON TRUE
    LEFT JOIN d ON a.x = d.x
    LEFT OUTER JOIN e ON a.x = e.x
    CROSS JOIN f, g
  `);
  assert.deepEqual(
    select.joins.map((join) => [join.kind, join.table.name, join.on === null]),
    [
      ['inner', 'b', false],
      ['inner', 'c', false],
      ['left', 'd', false],
      ['left', 'e', false],
      ['cross', 'f', true],
      ['cross', 'g', true],
    ],
  );
});

test('ASC is accepted and is the default', () => {
  const { select } = parse('SELECT a FROM t ORDER BY a ASC, b DESC, c');
  assert.deepEqual(
    select.orderBy.map((item) => item.descending),
    [false, true, false],
  );
});

test('EXPLAIN and EXPLAIN ANALYZE are recorded on the statement', () => {
  assert.equal(parse('EXPLAIN SELECT 1').explain, 'plan');
  assert.equal(parse('explain analyze SELECT 1').explain, 'analyze');
});

test('a script is split on semicolons and empty statements are skipped', () => {
  const statements = parseScript(';; SELECT 1 ; SELECT 2;\n\n;');
  assert.deepEqual(
    statements.map((statement) => statement.text),
    ['SELECT 1', 'SELECT 2'],
  );
  assert.deepEqual(parseScript('  -- nothing here\n'), []);
});

test('parse insists on exactly one statement', () => {
  syntaxError(() => parse('   '), /the query is empty/, 0);
  syntaxError(() => parse('SELECT 1; SELECT 2'), /expected one statement/, 10);
});

test('a misspelt keyword is reported where the parser gave up', () => {
  //FORM is taken for an alias, so the first thing that cannot be right is "people"
  syntaxError(
    () => parse('SELECT name FORM people'),
    /expected the end of the query but found "people"/,
    17,
  );
});

test('a missing piece is reported with what was expected', () => {
  syntaxError(
    () => parse('SELECT * FROM'),
    /expected a table name but found the end of the query/,
    13,
  );
  syntaxError(() => parse('SELECT a FROM t WHERE'), /expected an expression/, 21);
  syntaxError(() => parse('SELECT FROM t'), /expected an expression but found "FROM"/, 7);
  syntaxError(() => parse('SELECT a FROM t JOIN u'), /expected ON/, 22);
  syntaxError(() => parse('SELECT a FROM t GROUP a'), /expected BY but found "a"/, 22);
  syntaxError(() => parseExpression('(1 + 2'), /expected "\)"/, 6);
  syntaxError(() => parseExpression('1 +'), /expected an expression/, 3);
  syntaxError(() => parseExpression('a IN ()'), /expected an expression but found "\)"/, 6);
  syntaxError(() => parseExpression('CASE a END'), /expected WHEN but found "END"/, 7);
  syntaxError(() => parseExpression('a b'), /expected the end of the expression but found "b"/, 2);
  syntaxError(() => parseExpression('t.'), /expected a column name/, 2);
});

test('LIMIT and OFFSET need whole numbers', () => {
  syntaxError(() => parse('SELECT a FROM t LIMIT x'), /expected a whole number after LIMIT/, 22);
  syntaxError(() => parse('SELECT a FROM t LIMIT 2.5'), /whole number after LIMIT/, 22);
  syntaxError(() => parse('SELECT a FROM t LIMIT -1'), /whole number after LIMIT/, 22);
  syntaxError(() => parse('SELECT a FROM t LIMIT 1 OFFSET y'), /whole number after OFFSET/, 31);
});

test('unsupported features say so instead of failing somewhere odd', () => {
  syntaxError(
    () => parse('SELECT * FROM a RIGHT JOIN b ON TRUE'),
    /RIGHT JOIN is not supported/,
    16,
  );
  syntaxError(() => parse('SELECT * FROM a FULL JOIN b ON TRUE'), /FULL JOIN is not supported/, 16);
  syntaxError(() => parse('SELECT * FROM (SELECT 1)'), /subqueries are not supported/, 14);
  syntaxError(() => parse('SELECT (SELECT 1)'), /subqueries are not supported/, 8);
  syntaxError(() => parse('SELECT a IN (SELECT 1) FROM t'), /subqueries are not supported/, 13);
  syntaxError(
    () => parse('SELECT 1 UNION SELECT 2'),
    /expected the end of the query but found "UNION"/,
    9,
  );
  syntaxError(() => parseExpression('CAST(a AS date)'), /unknown type "date"/, 10);
});
