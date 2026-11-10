import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shop } from './support/fixtures.js';

//the number of rows a node reported, found by the start of its line
function rowsAt(plan, operator) {
  const line = plan.split('\n').find((candidate) => candidate.includes(operator));
  assert.ok(line, `no ${operator} line in:\n${plan}`);
  return Number(/\[([\d,]+) rows?, [\d.]+ ms\]$/.exec(line)[1].replaceAll(',', ''));
}

test('EXPLAIN ANALYZE runs the query and reports the rows through each node', async (t) => {
  const db = await shop(t);
  const sql = `SELECT p.name, COUNT(*) FROM people p JOIN orders o ON o.person_id = p.id
               WHERE o.amount > 10 GROUP BY p.name`;
  const plan = await db.explain(sql, { analyze: true });
  assert.equal(rowsAt(plan, 'Scan people.csv'), 5);
  assert.equal(rowsAt(plan, 'Scan orders.csv'), 6);
  assert.equal(rowsAt(plan, 'Filter o.amount > 10'), 3);
  assert.equal(rowsAt(plan, 'Hash join'), 3);
  assert.equal(rowsAt(plan, 'Aggregate'), 2);
  assert.equal(rowsAt(plan, 'Project'), 2);
  assert.match(plan, /\n\n2 rows in [\d.]+ ms$/);
});

test('without analyze nothing is run and no counts are shown', async (t) => {
  const db = await shop(t);
  assert.doesNotMatch(await db.explain('SELECT * FROM people'), /ms/);
});

test('EXPLAIN ANALYZE can be written as a statement', async (t) => {
  const db = await shop(t);
  const { columns, rows } = await db.query(
    'EXPLAIN ANALYZE SELECT COUNT(*) FROM people WHERE age > 40',
  );
  assert.deepEqual(columns, ['plan']);
  const plan = rows.map((row) => row[0]).join('\n');
  assert.equal(rowsAt(plan, 'Filter age > 40'), 2);
  assert.match(plan, /\n\n1 row in [\d.]+ ms$/);
});

test('a LIMIT stops the scan long before the end of the file', async (t) => {
  const lines = ['id,word'];
  for (let id = 0; id < 20000; id++) lines.push(`${id},word${id}`);
  const db = await shop(t, { files: { 'big.csv': lines.join('\n') }, chunkSize: 1024 });

  const limited = await db.explain('SELECT id FROM big LIMIT 5', { analyze: true });
  assert.equal(rowsAt(limited, 'Limit 5'), 5);
  assert.ok(rowsAt(limited, 'Scan big.csv') < 500, limited);

  const filtered = await db.explain("SELECT id FROM big WHERE word = 'word150' LIMIT 1", {
    analyze: true,
  });
  assert.ok(rowsAt(filtered, 'Scan big.csv') < 1000, filtered);

  //a sort has to see every row, so there the limit saves nothing on reading
  const sorted = await db.explain('SELECT id FROM big ORDER BY id DESC LIMIT 5', { analyze: true });
  assert.equal(rowsAt(sorted, 'Scan big.csv'), 20000);
  assert.equal(rowsAt(sorted, 'Top 5'), 5);
});

test('the database can list its tables and describe one', async (t) => {
  const db = await shop(t);
  assert.deepEqual(await db.tables(), [
    { name: 'orders', file: 'orders.csv' },
    { name: 'people', file: 'people.csv' },
  ]);
  const schema = await db.schema('PEOPLE');
  assert.equal(schema.estimatedRows, 5);
  assert.deepEqual(
    schema.columns.map((column) => `${column.name}:${column.type}`),
    ['id:integer', 'name:text', 'city:text', 'age:integer', 'member:boolean'],
  );
  await assert.rejects(db.schema('nothing'), /table "nothing" was not found/);
});
