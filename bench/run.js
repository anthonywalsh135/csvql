//the benchmark. generates a shop with a million orders, the first time it is
//run, and times a set of queries on it. most queries are timed twice, with one
//optimiser rule switched on and off, to show what that rule is worth.
//
//  npm run bench

import { existsSync, statSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';

import { generateData } from '../scripts/generate-data.js';
import { Database } from '../src/index.js';

const LARGE = join(import.meta.dirname, 'data', 'large');
const SMALL = join(import.meta.dirname, 'data', 'small');
const RUNS = 3;

const REVENUE = `SELECT c.country, COUNT(*) AS orders, SUM(o.quantity * p.price) AS revenue
  FROM orders o, customers c, products p
  WHERE o.customer_id = c.id AND o.product_id = p.id AND o.status = 'delivered'
  GROUP BY c.country ORDER BY revenue DESC`;
const PENDING = `SELECT COUNT(*) FROM orders o JOIN customers c ON o.customer_id = c.id
  WHERE c.country = 'Ireland' AND o.status = 'pending'`;
const LATEST = 'SELECT id, customer_id FROM orders ORDER BY ordered_on DESC, id LIMIT 10';
const BY_STATUS = 'SELECT status, COUNT(*), SUM(quantity) FROM orders GROUP BY status';

//each case is [what it shows, directory, query, optimiser switches]
const CASES = [
  ['count every row', LARGE, 'SELECT COUNT(*) FROM orders', {}],
  ['group and sum', LARGE, BY_STATUS, {}],
  ['  reading every column', LARGE, BY_STATUS, { pruneColumns: false }],
  ['first 10 rows', LARGE, 'SELECT * FROM orders LIMIT 10', {}],
  ['latest 10 of a million', LARGE, LATEST, {}],
  ['  with a full sort', LARGE, LATEST, { topN: false }],
  ['join with filters', LARGE, PENDING, {}],
  ['  filtering after the join', LARGE, PENDING, { pushDownPredicates: false }],
  ['three-table join', LARGE, REVENUE, {}],
  ['three-table join, small', SMALL, REVENUE, {}],
  ['  with nested loops', SMALL, REVENUE, { hashJoins: false }],
];

function ensureData() {
  if (!existsSync(join(LARGE, 'orders.csv'))) {
    console.log('generating bench/data (once only) ...');
    generateData(LARGE, { orders: 1_000_000, customers: 50_000, products: 1_000 });
    generateData(SMALL, { orders: 20_000, customers: 2_000, products: 200 });
  }
}

//the quickest of a few runs, which is the one least disturbed by other things
async function time(directory, sql, optimizer) {
  let best = Infinity;
  for (let run = 0; run < RUNS; run++) {
    //a new database each time, so that nothing is remembered between runs
    const db = new Database({ dir: directory, optimizer });
    const started = performance.now();
    await db.query(sql);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

ensureData();
const megabytes = statSync(join(LARGE, 'orders.csv')).size / 1e6;
console.log(
  `${cpus()[0].model.trim()}, ${Math.round(totalmem() / 2 ** 30)} GB, node ${process.version}`,
);
console.log(`orders.csv: 1,000,000 rows, ${megabytes.toFixed(1)} MB\n`);
console.log(`${'query'.padEnd(30)} ${'time'.padStart(10)}`);

let scanMs = 0;
for (const [name, directory, sql, optimizer] of CASES) {
  const ms = await time(directory, sql, optimizer);
  if (name === 'count every row') scanMs = ms;
  console.log(`${name.padEnd(30)} ${`${ms.toFixed(ms < 100 ? 1 : 0)} ms`.padStart(10)}`);
}
const rate = Math.round(1_000_000 / (scanMs / 1000)).toLocaleString('en-GB');
console.log(`\nscan rate: ${rate} rows/s, ${(megabytes / (scanMs / 1000)).toFixed(0)} MB/s`);
