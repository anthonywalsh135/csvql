import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BindError } from '../src/errors.js';
import { bind } from '../src/plan/binder.js';
import { outputColumns } from '../src/plan/nodes.js';
import { formatExpr } from '../src/sql/format.js';
import { parse } from '../src/sql/parser.js';

const table = (name, ...columns) => ({
  name,
  columns: columns.map((column) => ({ name: column, type: 'text' })),
});
const people = table('people', 'id', 'Name', 'city', 'age');
const orders = table('orders', 'id', 'person_id', 'total');

const plan = (sql, tables = [people]) => bind(parse(sql).select, tables);

//the operators of a plan from the top down, such as "project > filter > scan"
function outline(node) {
  if (node.type === 'join') return `${node.kind}(${outline(node.left)}, ${outline(node.right)})`;
  return node.input === undefined ? node.type : `${node.type} > ${outline(node.input)}`;
}

//the first node of the given type, searching down from the top
function find(node, type) {
  if (node.type === type) return node;
  for (const input of [node.input, node.left, node.right]) {
    const found = input && find(input, type);
    if (found) return found;
  }
  return null;
}

function bindError(sql, message, position, tables) {
  assert.throws(
    () => plan(sql, tables),
    (error) => {
      assert.ok(error instanceof BindError, `expected a bind error, got ${error}`);
      assert.match(error.message, message);
      if (position !== undefined) assert.equal(error.position, position);
      return true;
    },
  );
}

test('clauses become operators in the order they are evaluated', () => {
  assert.equal(outline(plan('SELECT name FROM people').plan), 'project > scan');
  assert.equal(
    outline(plan('SELECT name FROM people WHERE age > 30 ORDER BY age LIMIT 5').plan),
    'limit > project > sort > filter > scan',
  );
  assert.equal(outline(plan('SELECT 1 + 1').plan), 'project > one-row');
});

test('columns are matched without regard to case and headed by their real name', () => {
  const { columns, plan: tree } = plan(
    'SELECT NAME, people.CITY, age + 1, age AS years FROM people',
  );
  assert.deepEqual(columns, ['Name', 'city', 'age + 1', 'years']);
  assert.equal(outputColumns(tree).length, 4);
});

test('a star expands to every column, in file order', () => {
  assert.deepEqual(plan('SELECT * FROM people').columns, ['id', 'Name', 'city', 'age']);
  const joined = plan('SELECT o.*, p.Name FROM people p JOIN orders o ON o.person_id = p.id', [
    people,
    orders,
  ]);
  assert.deepEqual(joined.columns, ['id', 'person_id', 'total', 'Name']);
  bindError('SELECT *', /SELECT \* needs a FROM clause/, 7);
  bindError('SELECT x.* FROM people', /no table called "x"/, 7);
});

test('columns are labelled with their table only when there is more than one', () => {
  const single = find(plan('SELECT * FROM people WHERE age > 1').plan, 'filter');
  assert.equal(formatExpr(single.predicate), 'age > 1');
  const joined = plan('SELECT * FROM people p JOIN orders ON person_id = p.id', [people, orders]);
  assert.equal(formatExpr(find(joined.plan, 'join').condition), 'orders.person_id = p.id');
});

test('joins nest to the left and ON cannot see tables that come later', () => {
  const third = table('cities', 'city', 'country');
  const sql =
    'SELECT * FROM people p JOIN orders o ON o.person_id = p.id LEFT JOIN cities c ON c.city = p.city';
  assert.equal(
    outline(plan(sql, [people, orders, third]).plan),
    'project > left(inner(scan, scan), scan)',
  );
  bindError(
    'SELECT * FROM people p JOIN orders o ON o.person_id = c.city JOIN cities c ON TRUE',
    /no table called "c"/,
    54,
    [people, orders, third],
  );
});

test('a grouped query computes its aggregates once, below the select list', () => {
  const { plan: tree, columns } = plan(`
    SELECT city, COUNT(*) AS n, COUNT(*) * 2, MAX(age) - MIN(age)
    FROM people WHERE age > 18 GROUP BY city HAVING COUNT(*) > 1 ORDER BY n DESC`);
  assert.equal(outline(tree), 'project > sort > filter > aggregate > filter > scan');
  assert.deepEqual(columns, ['city', 'n', 'COUNT(*) * 2', 'MAX(age) - MIN(age)']);

  const aggregate = find(tree, 'aggregate');
  assert.deepEqual(
    aggregate.groups.map((group) => group.label),
    ['city'],
  );
  assert.deepEqual(
    aggregate.aggregates.map((entry) => entry.label),
    ['COUNT(*)', 'MAX(age)', 'MIN(age)'],
  );
  assert.equal(formatExpr(tree.items[2].expr), 'COUNT(*) * 2');
  assert.equal(formatExpr(tree.input.keys[0].expr), 'COUNT(*)');
  assert.equal(formatExpr(tree.input.input.predicate), 'COUNT(*) > 1');
});

test('an aggregate or HAVING with no GROUP BY makes one group of everything', () => {
  assert.equal(outline(plan('SELECT COUNT(*) FROM people').plan), 'project > aggregate > scan');
  assert.equal(
    outline(plan('SELECT 1 FROM people HAVING MAX(age) > 1').plan),
    'project > filter > aggregate > scan',
  );
  assert.equal(
    outline(plan('SELECT 1 FROM people ORDER BY SUM(age)').plan),
    'project > sort > aggregate > scan',
  );
});

test('GROUP BY and ORDER BY accept positions, aliases and whole expressions', () => {
  const byPosition = find(
    plan('SELECT UPPER(city), COUNT(*) FROM people GROUP BY 1 ORDER BY 2').plan,
    'aggregate',
  );
  assert.equal(byPosition.groups[0].label, 'UPPER(city)');
  const byAlias = find(
    plan('SELECT UPPER(city) AS c, COUNT(*) FROM people GROUP BY c').plan,
    'aggregate',
  );
  assert.equal(byAlias.groups[0].label, 'UPPER(city)');
  const byExpression = plan('SELECT UPPER(city), COUNT(*) FROM people GROUP BY UPPER(city)').plan;
  assert.equal(formatExpr(byExpression.items[0].expr), 'UPPER(city)');
  assert.equal(byExpression.items[0].expr.type, 'column', 'the select item reads the group key');
  bindError('SELECT city FROM people ORDER BY 3', /ORDER BY position 3 is not in the select list/);
  bindError('SELECT city FROM people GROUP BY 0', /GROUP BY position 0/);
});

test('an alias wins in ORDER BY, but a real column wins in GROUP BY and HAVING', () => {
  const sorted = plan('SELECT age + 1 AS age FROM people ORDER BY age').plan;
  assert.equal(formatExpr(sorted.input.keys[0].expr), 'age + 1');
  const grouped = find(
    plan('SELECT UPPER(city) AS city, COUNT(*) FROM people GROUP BY city').plan,
    'aggregate',
  );
  assert.equal(grouped.groups[0].label, 'city');
  const having = plan('SELECT city, COUNT(*) AS n FROM people GROUP BY city HAVING n > 1').plan;
  assert.equal(formatExpr(having.input.predicate), 'COUNT(*) > 1');
});

test('DISTINCT sorts after removing duplicates, on the output columns', () => {
  const tree = plan('SELECT DISTINCT city, age FROM people ORDER BY age DESC, 1 LIMIT 3').plan;
  assert.equal(outline(tree), 'limit > sort > distinct > project > scan');
  const projected = find(tree, 'project').items.map((item) => item.id);
  assert.deepEqual(
    find(tree, 'sort').keys.map((key) => key.expr.id),
    [projected[1], projected[0]],
  );
  bindError(
    'SELECT DISTINCT city FROM people ORDER BY age',
    /with SELECT DISTINCT, ORDER BY can only use/,
  );
});

test('a name that matches nothing is an error with a suggestion', () => {
  bindError('SELECT nmae FROM people', /unknown column "nmae"; did you mean "Name"\?/, 7);
  bindError('SELECT zzz FROM people', /^unknown column "zzz"$/, 7);
  bindError('SELECT p.age FROM people', /no table called "p" in this query/, 7);
  bindError('SELECT peple.age FROM people', /did you mean "people"\?/);
  bindError('SELECT people.total FROM people', /unknown column "total"/);
});

test('a name that matches two tables has to be qualified', () => {
  const sql = 'SELECT id FROM people p JOIN orders o ON TRUE';
  bindError(sql, /column "id" is in more than one table; write p\.id or o\.id/, 7, [
    people,
    orders,
  ]);
  bindError('SELECT 1 FROM people JOIN people ON TRUE', /"people" is used for two tables/, 26, [
    people,
    people,
  ]);
  assert.doesNotThrow(() =>
    plan('SELECT a.id FROM people a JOIN people b ON a.id = b.id', [people, people]),
  );
});

test('columns outside GROUP BY cannot be selected without an aggregate', () => {
  bindError(
    'SELECT city, age FROM people GROUP BY city',
    /column "age" must appear in GROUP BY or be used inside an aggregate/,
    13,
  );
  bindError('SELECT Name, COUNT(*) FROM people', /column "Name" must appear in GROUP BY/, 7);
  bindError('SELECT city FROM people GROUP BY city ORDER BY age', /column "age" must appear/);
  bindError('SELECT city FROM people GROUP BY city HAVING age > 1', /column "age" must appear/);
  assert.doesNotThrow(() => plan('SELECT age + 1, age FROM people GROUP BY age'));
});

test('aggregates are refused where they make no sense', () => {
  bindError(
    'SELECT * FROM people WHERE COUNT(*) > 1',
    /COUNT cannot be used in WHERE; to filter on an aggregate, use HAVING/,
    27,
  );
  bindError('SELECT SUM(COUNT(*)) FROM people', /COUNT cannot be used in the argument of SUM/, 11);
  bindError('SELECT 1 FROM people GROUP BY SUM(age)', /SUM cannot be used in GROUP BY/);
  bindError('SELECT COUNT(*) AS n FROM people GROUP BY n', /GROUP BY cannot contain an aggregate/);
  bindError(
    'SELECT * FROM people p JOIN orders o ON MAX(o.id) = 1',
    /MAX cannot be used in ON/,
    40,
    [people, orders],
  );
  bindError('SELECT SUM(*) FROM people', /only COUNT can take \*/, 7);
  bindError('SELECT SUM(age, id) FROM people', /SUM takes 1 argument but was given 2/, 7);
});

test('function calls are checked for name and number of arguments', () => {
  bindError('SELECT UPER(Name) FROM people', /unknown function UPER; did you mean "UPPER"\?/, 7);
  bindError('SELECT UPPER(Name, city) FROM people', /UPPER takes 1 arguments but was given 2/, 7);
  bindError('SELECT SUBSTR(Name) FROM people', /SUBSTR takes 2 to 3 arguments but was given 1/);
  bindError('SELECT COALESCE() FROM people', /COALESCE takes at least 1 arguments but was given 0/);
  bindError('SELECT UPPER(DISTINCT Name) FROM people', /UPPER is not an aggregate/);
  assert.doesNotThrow(() => plan('SELECT COALESCE(Name, city, 1, 2, 3) FROM people'));
});
