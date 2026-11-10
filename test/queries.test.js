import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BindError, CsvError, ExecutionError, SqlSyntaxError } from '../src/index.js';
import { shop } from './support/fixtures.js';

const rowsOf = async (db, sql) => (await db.query(sql)).rows;
const columnOf = async (db, sql) => (await rowsOf(db, sql)).map((row) => row[0]);

test('a whole table comes back with its values typed', async (t) => {
  const db = await shop(t);
  assert.deepEqual(await db.query('SELECT * FROM people'), {
    columns: ['id', 'name', 'city', 'age', 'member'],
    rows: [
      [1, 'Ada', 'London', 36, true],
      [2, 'Grace', 'New York', 45, false],
      [3, 'Alan', 'London', 41, true],
      [4, 'Edsger', 'Rotterdam', null, false],
      [5, 'Barbara', null, 28, true],
    ],
  });
});

test('WHERE keeps a row only when its condition is true', async (t) => {
  const db = await shop(t);
  assert.deepEqual(await columnOf(db, 'SELECT name FROM people WHERE age > 40'), ['Grace', 'Alan']);
  //edsger has no age, and is in neither answer
  assert.deepEqual(await columnOf(db, 'SELECT name FROM people WHERE NOT age > 40'), [
    'Ada',
    'Barbara',
  ]);
  assert.deepEqual(await columnOf(db, 'SELECT name FROM people WHERE age IS NULL'), ['Edsger']);
  assert.deepEqual(await columnOf(db, "SELECT name FROM people WHERE member AND city = 'London'"), [
    'Ada',
    'Alan',
  ]);
  assert.deepEqual(await columnOf(db, "SELECT name FROM people WHERE city LIKE '%ON%'"), [
    'Ada',
    'Alan',
  ]);
  assert.deepEqual(await columnOf(db, 'SELECT name FROM people WHERE id IN (2, 5, 9)'), [
    'Grace',
    'Barbara',
  ]);
  assert.deepEqual(await columnOf(db, 'SELECT name FROM people WHERE age BETWEEN 36 AND 41'), [
    'Ada',
    'Alan',
  ]);
});

test('the select list can compute, rename and repeat columns', async (t) => {
  const db = await shop(t);
  const sql =
    "SELECT name || ' (' || city || ')' AS label, age * 2, id, ID FROM people WHERE id <= 2";
  assert.deepEqual(await db.query(sql), {
    columns: ['label', 'age * 2', 'id', 'id'],
    rows: [
      ['Ada (London)', 72, 1, 1],
      ['Grace (New York)', 90, 2, 2],
    ],
  });
});

test('ORDER BY sorts nulls first, and last when descending', async (t) => {
  const db = await shop(t);
  const byAge = ['Edsger', 'Barbara', 'Ada', 'Alan', 'Grace'];
  assert.deepEqual(await columnOf(db, 'SELECT name FROM people ORDER BY age'), byAge);
  assert.deepEqual(
    await columnOf(db, 'SELECT name FROM people ORDER BY age DESC'),
    byAge.toReversed(),
  );
});

test('ORDER BY takes several keys, expressions, aliases and positions', async (t) => {
  const db = await shop(t);
  assert.deepEqual(await columnOf(db, 'SELECT name FROM people ORDER BY city, name DESC'), [
    'Barbara',
    'Alan',
    'Ada',
    'Grace',
    'Edsger',
  ]);
  assert.deepEqual(await columnOf(db, 'SELECT name FROM people ORDER BY -id LIMIT 2'), [
    'Barbara',
    'Edsger',
  ]);
  assert.deepEqual(
    await rowsOf(db, 'SELECT name, age * 2 AS double FROM people ORDER BY double DESC LIMIT 2'),
    [
      ['Grace', 90],
      ['Alan', 82],
    ],
  );
  assert.deepEqual(await columnOf(db, 'SELECT name, member FROM people ORDER BY 2, 1'), [
    'Edsger',
    'Grace',
    'Ada',
    'Alan',
    'Barbara',
  ]);
});

test('rows that tie in a sort keep the order they were read in', async (t) => {
  const db = await shop(t);
  assert.deepEqual(await columnOf(db, 'SELECT name FROM people ORDER BY member'), [
    'Grace',
    'Edsger',
    'Ada',
    'Alan',
    'Barbara',
  ]);
});

test('LIMIT and OFFSET take a window of the result', async (t) => {
  const db = await shop(t);
  assert.deepEqual(
    await columnOf(db, 'SELECT id FROM people ORDER BY id LIMIT 2 OFFSET 1'),
    [2, 3],
  );
  assert.deepEqual(await columnOf(db, 'SELECT id FROM people LIMIT 2'), [1, 2]);
  assert.deepEqual(await columnOf(db, 'SELECT id FROM people LIMIT 0'), []);
  assert.deepEqual(await columnOf(db, 'SELECT id FROM people LIMIT 10 OFFSET 4'), [5]);
  assert.deepEqual(await columnOf(db, 'SELECT id FROM people LIMIT 10 OFFSET 5'), []);
});

test('DISTINCT treats nulls as equal to each other', async (t) => {
  const db = await shop(t);
  assert.deepEqual(await columnOf(db, 'SELECT DISTINCT city FROM people ORDER BY city'), [
    null,
    'London',
    'New York',
    'Rotterdam',
  ]);
  assert.deepEqual(await rowsOf(db, 'SELECT DISTINCT member, city IS NULL FROM people'), [
    [true, false],
    [false, false],
    [true, true],
  ]);
  assert.deepEqual(
    await columnOf(db, 'SELECT DISTINCT member FROM people ORDER BY member DESC LIMIT 1'),
    [true],
  );
});

test('aggregates over a whole table ignore nulls', async (t) => {
  const db = await shop(t);
  const sql = 'SELECT COUNT(*), COUNT(age), SUM(age), AVG(age), MIN(age), MAX(name) FROM people';
  assert.deepEqual(await rowsOf(db, sql), [[5, 4, 150, 37.5, 28, 'Grace']]);
  assert.deepEqual(
    await rowsOf(db, 'SELECT COUNT(DISTINCT city), COUNT(DISTINCT member) FROM people'),
    [[3, 2]],
  );
});

test('aggregates over no rows still give one row', async (t) => {
  const db = await shop(t);
  assert.deepEqual(
    await rowsOf(db, 'SELECT COUNT(*), SUM(age), MAX(age) FROM people WHERE id > 100'),
    [[0, null, null]],
  );
  //but a grouped query over no rows has no groups
  assert.deepEqual(
    await rowsOf(db, 'SELECT city, COUNT(*) FROM people WHERE id > 100 GROUP BY city'),
    [],
  );
});

test('GROUP BY puts nulls in a group of their own', async (t) => {
  const db = await shop(t);
  const sql = 'SELECT city, COUNT(*) AS n, AVG(age) FROM people GROUP BY city ORDER BY city';
  assert.deepEqual(await db.query(sql), {
    columns: ['city', 'n', 'AVG(age)'],
    rows: [
      [null, 1, 28],
      ['London', 2, 38.5],
      ['New York', 1, 45],
      ['Rotterdam', 1, null],
    ],
  });
});

test('GROUP BY can use several keys and expressions', async (t) => {
  const db = await shop(t);
  const sql = `SELECT member, city IS NULL AS homeless, COUNT(*) FROM people
               GROUP BY member, city IS NULL ORDER BY 1, 2`;
  assert.deepEqual(await rowsOf(db, sql), [
    [false, false, 2],
    [true, false, 2],
    [true, true, 1],
  ]);
  assert.deepEqual(
    await rowsOf(db, 'SELECT age > 40, COUNT(*) FROM people GROUP BY age > 40 ORDER BY 1'),
    [
      [null, 1],
      [false, 2],
      [true, 2],
    ],
  );
});

test('HAVING filters groups, and can use aggregates that are not selected', async (t) => {
  const db = await shop(t);
  assert.deepEqual(
    await columnOf(db, 'SELECT city FROM people GROUP BY city HAVING COUNT(*) > 1'),
    ['London'],
  );
  const sql =
    'SELECT member, MAX(age) AS oldest FROM people GROUP BY member HAVING oldest > 41 ORDER BY SUM(age)';
  assert.deepEqual(await rowsOf(db, sql), [[false, 45]]);
});

test('an inner join pairs rows that satisfy the condition', async (t) => {
  const db = await shop(t);
  const sql =
    'SELECT p.name, o.item FROM people p JOIN orders o ON o.person_id = p.id ORDER BY o.id';
  assert.deepEqual(await rowsOf(db, sql), [
    ['Ada', 'book'],
    ['Ada', 'pen'],
    ['Alan', 'book'],
    ['Alan', 'laptop'],
    ['Grace', 'pen'],
  ]);
});

test('a left join keeps the left rows that have no partner', async (t) => {
  const db = await shop(t);
  const totals = `SELECT p.name, COUNT(o.id) AS orders, SUM(o.amount) AS spent
                  FROM people p LEFT JOIN orders o ON o.person_id = p.id
                  GROUP BY p.name ORDER BY p.name`;
  assert.deepEqual(await rowsOf(db, totals), [
    ['Ada', 2, 13.75],
    ['Alan', 2, 1019.99],
    ['Barbara', 0, null],
    ['Edsger', 0, null],
    ['Grace', 1, null],
  ]);
  const without =
    'SELECT p.name FROM people p LEFT JOIN orders o ON o.person_id = p.id WHERE o.id IS NULL';
  assert.deepEqual(await columnOf(db, without), ['Edsger', 'Barbara']);
});

test('a condition in ON decides matches, where one in WHERE removes rows', async (t) => {
  const db = await shop(t);
  const join = 'FROM people p LEFT JOIN orders o ON o.person_id = p.id';
  assert.deepEqual(
    await rowsOf(db, `SELECT p.name, o.item ${join} AND o.item = 'book' ORDER BY p.id`),
    [
      ['Ada', 'book'],
      ['Grace', null],
      ['Alan', 'book'],
      ['Edsger', null],
      ['Barbara', null],
    ],
  );
  assert.deepEqual(
    await rowsOf(db, `SELECT p.name, o.item ${join} WHERE o.item = 'book' ORDER BY p.id`),
    [
      ['Ada', 'book'],
      ['Alan', 'book'],
    ],
  );
  //a condition on the left table in ON does not remove left rows either
  assert.deepEqual(
    await rowsOf(db, `SELECT p.name, o.item ${join} AND p.id = 2 ORDER BY p.id LIMIT 3`),
    [
      ['Ada', null],
      ['Grace', 'pen'],
      ['Alan', null],
    ],
  );
});

test('cross joins, comma joins and joins on any condition', async (t) => {
  const db = await shop(t);
  assert.deepEqual(await columnOf(db, 'SELECT COUNT(*) FROM people, orders'), [30]);
  assert.deepEqual(await columnOf(db, 'SELECT COUNT(*) FROM people CROSS JOIN orders'), [30]);
  const comma = 'SELECT COUNT(*) FROM people, orders WHERE people.id = orders.person_id';
  assert.deepEqual(await columnOf(db, comma), [5]);
  assert.deepEqual(
    await columnOf(db, 'SELECT COUNT(*) FROM people p JOIN orders o ON o.amount > p.age'),
    [4],
  );
});

test('a table can be joined to itself, and three tables can be joined', async (t) => {
  const db = await shop(t);
  const pairs =
    'SELECT a.name, b.name FROM people a JOIN people b ON a.city = b.city AND a.id < b.id';
  assert.deepEqual(await rowsOf(db, pairs), [['Ada', 'Alan']]);
  const sameItem = `SELECT p.name, q.name, o.item
                    FROM people p JOIN orders o ON o.person_id = p.id
                    JOIN orders o2 ON o2.item = o.item AND o2.id > o.id
                    JOIN people q ON q.id = o2.person_id ORDER BY o.item`;
  assert.deepEqual(await rowsOf(db, sameItem), [
    ['Ada', 'Alan', 'book'],
    ['Ada', 'Grace', 'pen'],
  ]);
});

test('a query needs no table at all', async (t) => {
  const db = await shop(t);
  assert.deepEqual(await db.query("SELECT 1 + 1 AS two, UPPER('x')"), {
    columns: ['two', "UPPER('x')"],
    rows: [[2, 'X']],
  });
  assert.deepEqual(await rowsOf(db, 'SELECT 1 WHERE 1 > 2'), []);
});

test('a table can be named by a quoted path', async (t) => {
  const db = await shop(t);
  assert.deepEqual(await columnOf(db, "SELECT COUNT(*) FROM 'people.csv'"), [5]);
  assert.deepEqual(await columnOf(db, "SELECT people.name FROM 'people.csv' LIMIT 1"), ['Ada']);
  assert.deepEqual(await columnOf(db, "SELECT x.name FROM 'people.csv' AS x LIMIT 1"), ['Ada']);
});

test('column names with spaces or keywords in them can be quoted', async (t) => {
  const db = await shop(t, { files: { 'odd.csv': 'first name,order,select\nAda,1,x\n' } });
  assert.deepEqual(await rowsOf(db, 'SELECT "first name", [order], odd."select" FROM odd'), [
    ['Ada', 1, 'x'],
  ]);
});

test('other delimiters are detected', async (t) => {
  const db = await shop(t, { files: { 'semi.csv': 'a;b\n1;x,y\n', 'tabs.tsv': 'a\tb\n2\tz\n' } });
  assert.deepEqual(await rowsOf(db, 'SELECT * FROM semi'), [[1, 'x,y']]);
  assert.deepEqual(await rowsOf(db, 'SELECT * FROM tabs'), [[2, 'z']]);
});

test('a value that does not fit its column stays as text', async (t) => {
  const db = await shop(t, { files: { 'nums.csv': 'n\n1\n2\noops\n4\n' }, sampleRows: 2 });
  assert.deepEqual(await columnOf(db, 'SELECT n FROM nums'), [1, 2, 'oops', 4]);
  assert.deepEqual(await columnOf(db, 'SELECT n FROM nums ORDER BY n DESC'), ['oops', 4, 2, 1]);
  assert.deepEqual(await columnOf(db, "SELECT COUNT(*) FROM nums WHERE n = 'oops'"), [1]);
  await assert.rejects(
    db.query('SELECT SUM(n) FROM nums'),
    (error) =>
      error instanceof ExecutionError &&
      /SUM expects numbers but got the text 'oops'/.test(error.message),
  );
  await assert.rejects(
    db.query('SELECT n + 1 FROM nums'),
    /cannot apply \+ to the text 'oops' and the number 1/,
  );
});

test('a table with a header and no rows behaves like an empty table', async (t) => {
  const db = await shop(t, { files: { 'none.csv': 'a,b\n' } });
  assert.deepEqual(await db.query('SELECT * FROM none'), { columns: ['a', 'b'], rows: [] });
  assert.deepEqual(await rowsOf(db, 'SELECT COUNT(*), MAX(a) FROM none'), [[0, null]]);
  assert.deepEqual(await rowsOf(db, 'SELECT p.name FROM people p JOIN none n ON TRUE'), []);
  assert.deepEqual(
    await columnOf(db, 'SELECT COUNT(*) FROM people p LEFT JOIN none n ON TRUE'),
    [5],
  );
});

test('reading in tiny chunks does not change any answer', async (t) => {
  const sql = `SELECT p.city, COUNT(*), SUM(o.amount) FROM people p
               JOIN orders o ON o.person_id = p.id GROUP BY p.city ORDER BY 1`;
  const expected = await rowsOf(await shop(t), sql);
  assert.deepEqual(expected, [
    ['London', 4, 1033.74],
    ['New York', 1, null],
  ]);
  for (const chunkSize of [1, 7, 64]) {
    assert.deepEqual(await rowsOf(await shop(t, { chunkSize }), sql), expected);
  }
});

test('a stream gives the headings at once and the rows as they are asked for', async (t) => {
  const db = await shop(t);
  const { columns, rows } = await db.stream('SELECT id, name FROM people');
  assert.deepEqual(columns, ['id', 'name']);
  const seen = [];
  for await (const row of rows) {
    seen.push(row);
    if (seen.length === 2) break;
  }
  assert.deepEqual(seen, [
    [1, 'Ada'],
    [2, 'Grace'],
  ]);
});

test('each kind of mistake is reported as its own kind of error', async (t) => {
  const db = await shop(t, { files: { 'empty.csv': '', 'bad.csv': 'a,b\n1,"never closed\n' } });
  await assert.rejects(db.query('SELECT FROM people'), SqlSyntaxError);
  await assert.rejects(db.query('SELECT nmae FROM people'), (error) => {
    assert.ok(error instanceof BindError);
    assert.equal(error.position, 7);
    assert.match(error.message, /did you mean "name"/);
    return true;
  });
  await assert.rejects(db.query('SELECT * FROM nowhere'), BindError);
  await assert.rejects(db.query('SELECT * FROM empty'), CsvError);
  await assert.rejects(db.query('SELECT * FROM bad'), CsvError);
  await assert.rejects(db.query('SELECT name + 1 FROM people'), ExecutionError);
});
