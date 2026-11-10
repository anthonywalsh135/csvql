//using csvql from code instead of from the command line
//
//  node examples/library.js

import { join } from 'node:path';

import { Database } from '../src/index.js';

const db = new Database({ dir: join(import.meta.dirname, 'data') });

//query() collects the whole result
const { columns, rows } = await db.query(`
  SELECT category, COUNT(*) AS products, MAX(price) AS dearest
  FROM products GROUP BY category ORDER BY category`);
console.log(columns.join(', '));
for (const row of rows) console.log(row.join(', '));

//stream() hands rows over as they are produced, so stopping early stops the
//file being read
const { rows: orders } = await db.stream(
  "SELECT id, ordered_on FROM orders WHERE status = 'pending'",
);
for await (const [id, orderedOn] of orders) {
  console.log(`the first pending order is ${id}, placed on ${orderedOn}`);
  break;
}
