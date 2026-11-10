//checks the engine against sqlite. random tables are written out as csv and
//also loaded into an in-memory sqlite database, random queries are run on
//both, and the rows have to match. each query is run a third time with the
//optimiser switched off, which has to give the same rows again.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { formatRecord } from '../src/csv/writer.js';
import { Database } from '../src/index.js';
import { tempDir } from './support/files.js';
import { SCHEMA, randomQuery, randomTables } from './support/generate.js';
import { createRandom } from './support/random.js';

//a longer run for hunting bugs: FUZZ_DATABASES=200 npm test
const DATABASES = Number(process.env.FUZZ_DATABASES ?? 12);
const QUERIES_EACH = 50;
const SQLITE_TYPES = { int: 'INTEGER', real: 'REAL', text: 'TEXT', bool: 'INTEGER' };

function toCsv(table, rows) {
  const lines = [Object.keys(SCHEMA[table]), ...rows].map((row) => formatRecord(row));
  return `${lines.join('\n')}\n`;
}

function loadIntoSqlite(tables) {
  const sqlite = new DatabaseSync(':memory:');
  for (const [table, rows] of Object.entries(tables)) {
    const columns = Object.entries(SCHEMA[table]);
    sqlite.exec(
      `CREATE TABLE ${table} (${columns.map(([name, type]) => `${name} ${SQLITE_TYPES[type]}`).join(', ')})`,
    );
    const insert = sqlite.prepare(
      `INSERT INTO ${table} VALUES (${columns.map(() => '?').join(', ')})`,
    );
    //sqlite has no boolean type and stores true and false as 1 and 0
    for (const row of rows) {
      insert.run(...row.map((value) => (typeof value === 'boolean' ? Number(value) : value)));
    }
  }
  return sqlite;
}

//one row as text, with the differences between the engines that are not
//errors smoothed over: booleans against 1 and 0, and the last bits of a float
function canonical(row) {
  return row
    .map((value) => {
      if (value === null) return 'null';
      if (typeof value === 'string') return JSON.stringify(value);
      return String(Number(Number(value).toPrecision(12)));
    })
    .join(' | ');
}

function compare(actual, expected, ordered, context) {
  const left = actual.map(canonical);
  const right = expected.map(canonical);
  if (!ordered) {
    left.sort();
    right.sort();
  }
  assert.deepEqual(left, right, context);
}

test('random queries give the same rows as sqlite, with and without the optimiser', async (t) => {
  let checked = 0;
  for (let seed = 1; seed <= DATABASES; seed++) {
    const random = createRandom(seed);
    //the first database has empty tables, the rest have a handful of rows
    const sizes =
      seed === 1
        ? { t1: 0, t2: 3, t3: 0 }
        : { t1: random.int(1, 12), t2: random.int(0, 14), t3: random.int(0, 6) };
    const tables = randomTables(random, sizes);
    const files = Object.fromEntries(
      Object.entries(tables).map(([table, rows]) => [`${table}.csv`, toCsv(table, rows)]),
    );
    const dir = await tempDir(t, files);
    const sqlite = loadIntoSqlite(tables);
    //every other database is read a few bytes at a time
    const optimised = new Database({ dir, chunkSize: seed % 2 === 0 ? 24 : undefined });
    const plain = new Database({ dir, optimizer: false });

    for (let query = 0; query < QUERIES_EACH; query++) {
      const { sql, ordered } = randomQuery(random);
      const context = `seed ${seed}, query ${query}: ${sql}`;
      let expected;
      try {
        expected = sqlite
          .prepare(sql)
          .all()
          .map((row) => Object.values(row));
      } catch (error) {
        assert.fail(`sqlite rejected a generated query (${error.message}); ${context}`);
      }
      const run = async (db) => (await db.query(sql)).rows;
      const actual = await run(optimised).catch((error) =>
        assert.fail(`${error.message}; ${context}`),
      );
      compare(actual, expected, ordered, context);
      compare(await run(plain), expected, ordered, `unoptimised; ${context}`);
      checked += 1;
    }
    sqlite.close();
  }
  assert.equal(checked, DATABASES * QUERIES_EACH);
});
