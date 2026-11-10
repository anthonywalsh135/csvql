import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bind } from '../src/plan/binder.js';
import { explainPlan } from '../src/plan/explain.js';
import { optimize } from '../src/plan/optimizer.js';
import { parse } from '../src/sql/parser.js';
import { shop } from './support/fixtures.js';

const table = (name, estimatedRows, ...columns) => ({
  name,
  file: `${name}.csv`,
  estimatedRows,
  columns: columns.map((column) => ({ name: column, type: 'text' })),
});
const people = table('people', 1000, 'id', 'name', 'city', 'age');
const orders = table('orders', 50000, 'id', 'person_id', 'item', 'amount');
const cities = table('cities', 40, 'city', 'country');

//the plan for a query as lines of text, with only the named rules applied
function planFor(sql, tables, ...rules) {
  const all = ['foldConstants', 'pushDownPredicates'];
  const switches = Object.fromEntries(all.map((rule) => [rule, rules.includes(rule)]));
  return explainPlan(optimize(bind(parse(sql).select, tables).plan, switches)).split('\n');
}

test('with every rule off the plan is the query as written', () => {
  const sql = "SELECT p.name FROM people p, orders o WHERE p.id = o.person_id AND o.item = 'pen'";
  const written = [
    'Project p.name',
    "└─ Filter p.id = o.person_id AND o.item = 'pen'",
    '   └─ Cross join',
    '      ├─ Scan people.csv as p (id, name, city, age) ~1,000 rows',
    '      └─ Scan orders.csv as o (id, person_id, item, amount) ~50,000 rows',
  ];
  assert.deepEqual(planFor(sql, [people, orders]), written);
  const plan = bind(parse(sql).select, [people, orders]).plan;
  assert.deepEqual(explainPlan(optimize(plan, false)).split('\n'), written);
});

test('a WHERE clause is split up and each part moved to the table it reads', () => {
  const sql = `SELECT p.name FROM people p, orders o
               WHERE p.id = o.person_id AND o.item = 'pen' AND p.age > 30 AND o.amount > p.age`;
  assert.deepEqual(planFor(sql, [people, orders], 'pushDownPredicates'), [
    'Project p.name',
    '└─ Join on p.id = o.person_id AND o.amount > p.age',
    '   ├─ Filter p.age > 30',
    '   │  └─ Scan people.csv as p (id, name, city, age) ~1,000 rows',
    "   └─ Filter o.item = 'pen'",
    '      └─ Scan orders.csv as o (id, person_id, item, amount) ~50,000 rows',
  ]);
});

test('conditions in ON that read one table are moved there too', () => {
  const sql =
    "SELECT 1 FROM people p JOIN orders o ON p.id = o.person_id AND p.city = 'Leeds' AND o.amount > 5";
  assert.deepEqual(planFor(sql, [people, orders], 'pushDownPredicates').slice(1), [
    '└─ Join on p.id = o.person_id',
    "   ├─ Filter p.city = 'Leeds'",
    '   │  └─ Scan people.csv as p (id, name, city, age) ~1,000 rows',
    '   └─ Filter o.amount > 5',
    '      └─ Scan orders.csv as o (id, person_id, item, amount) ~50,000 rows',
  ]);
});

test('predicates reach the right table through several joins', () => {
  const sql = `SELECT 1 FROM people p JOIN orders o ON o.person_id = p.id JOIN cities c ON c.city = p.city
               WHERE c.country = 'UK' AND o.amount > 10 AND p.age < 30`;
  assert.deepEqual(planFor(sql, [people, orders, cities], 'pushDownPredicates').slice(1), [
    '└─ Join on c.city = p.city',
    '   ├─ Join on o.person_id = p.id',
    '   │  ├─ Filter p.age < 30',
    '   │  │  └─ Scan people.csv as p (id, name, city, age) ~1,000 rows',
    '   │  └─ Filter o.amount > 10',
    '   │     └─ Scan orders.csv as o (id, person_id, item, amount) ~50,000 rows',
    "   └─ Filter c.country = 'UK'",
    '      └─ Scan cities.csv as c (city, country) ~40 rows',
  ]);
});

test('a left join only lets a predicate through where it cannot change the answer', () => {
  const sql = `SELECT 1 FROM people p LEFT JOIN orders o
               ON o.person_id = p.id AND o.amount > 5 AND p.age > 30
               WHERE p.city = 'Leeds' AND o.item IS NULL`;
  assert.deepEqual(planFor(sql, [people, orders], 'pushDownPredicates').slice(1), [
    //reads the right side, so it has to see the rows padded with nulls
    '└─ Filter o.item IS NULL',
    //the condition on p.age stays: it decides matches, it does not drop people
    '   └─ Left join on o.person_id = p.id AND p.age > 30',
    "      ├─ Filter p.city = 'Leeds'",
    '      │  └─ Scan people.csv as p (id, name, city, age) ~1,000 rows',
    '      └─ Filter o.amount > 5',
    '         └─ Scan orders.csv as o (id, person_id, item, amount) ~50,000 rows',
  ]);
});

test('a join whose whole condition moves away becomes a cross join', () => {
  const sql = "SELECT 1 FROM people p JOIN orders o ON o.item = 'pen'";
  assert.deepEqual(planFor(sql, [people, orders], 'pushDownPredicates').slice(1, 3), [
    '└─ Cross join',
    '   ├─ Scan people.csv as p (id, name, city, age) ~1,000 rows',
  ]);
});

test('filters stay above grouping, limits and sorts', () => {
  const sql =
    'SELECT city, COUNT(*) FROM people WHERE age > 1 GROUP BY city HAVING COUNT(*) > 2 ORDER BY 2 LIMIT 3';
  assert.deepEqual(planFor(sql, [people], 'pushDownPredicates'), [
    'Limit 3',
    '└─ Project city, COUNT(*)',
    '   └─ Sort by COUNT(*)',
    '      └─ Filter COUNT(*) > 2',
    '         └─ Aggregate by city: COUNT(*)',
    '            └─ Filter age > 1',
    '               └─ Scan people.csv (id, name, city, age) ~1,000 rows',
  ]);
});

test('constant expressions are worked out while planning', () => {
  const sql =
    "SELECT age + 2 * 3, UPPER('a') || 'b' AS ab FROM people WHERE age > 10 * 2 AND 1 = 1";
  assert.deepEqual(planFor(sql, [people], 'foldConstants', 'pushDownPredicates'), [
    "Project age + 6 AS age + 2 * 3, 'Ab' AS ab",
    '└─ Filter age > 20',
    '   └─ Scan people.csv (id, name, city, age) ~1,000 rows',
  ]);
});

test('a constant that would fail is left for the executor to deal with', () => {
  const sql = "SELECT CASE WHEN age > 0 THEN 1 ELSE 1 + 'a' END FROM people";
  assert.match(planFor(sql, [people], 'foldConstants')[0], /ELSE 1 \+ 'a' END/);
});

test('an unknown rule name is refused', () => {
  const plan = bind(parse('SELECT 1').select, []).plan;
  assert.throws(() => optimize(plan, { fastMode: false }), /no optimiser rule called fastMode/);
});

test('EXPLAIN shows the plan a query would run with', async (t) => {
  const db = await shop(t);
  const sql =
    'SELECT p.name FROM people p, orders o WHERE o.person_id = p.id AND o.amount > 15 + 5';
  const plan = await db.explain(sql);
  assert.match(plan, /Join on o\.person_id = p\.id/);
  assert.match(plan, /Filter o\.amount > 20\n/);
  assert.match(plan, /Scan people\.csv as p \(.*\) ~5 rows/);
  const { columns, rows } = await db.query(`EXPLAIN ${sql}`);
  assert.deepEqual(columns, ['plan']);
  assert.equal(rows.map((row) => row[0]).join('\n'), plan);
});

test('switching the optimiser off does not change any answer', async (t) => {
  const queries = [
    "SELECT p.name, o.item FROM people p, orders o WHERE o.person_id = p.id AND o.amount > 5 AND p.city = 'London'",
    'SELECT p.name, o.item FROM people p LEFT JOIN orders o ON o.person_id = p.id AND o.amount > 5 WHERE p.age > 30',
    'SELECT p.name FROM people p LEFT JOIN orders o ON o.person_id = p.id WHERE o.id IS NULL',
    'SELECT p.city, COUNT(*) FROM people p JOIN orders o ON o.person_id = p.id AND 1 = 1 GROUP BY p.city',
    'SELECT a.name, b.name FROM people a JOIN people b ON a.city = b.city WHERE a.id < b.id AND 2 > 1',
  ];
  const optimised = await shop(t);
  const plain = await shop(t, { optimizer: false });
  const sorted = (rows) => rows.map((row) => JSON.stringify(row)).sort();
  for (const sql of queries) {
    const expected = sorted((await plain.query(sql)).rows);
    assert.ok(expected.length > 0, sql);
    assert.deepEqual(sorted((await optimised.query(sql)).rows), expected, sql);
  }
});
