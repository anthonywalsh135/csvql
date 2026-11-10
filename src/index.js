//the public interface: a Database is a directory of csv files that can be
//queried with sql.
//
//  const db = new Database({ dir: './data' });
//  const { columns, rows } = await db.query('SELECT name FROM people LIMIT 3');

import { Catalog } from './catalog.js';
import { execute } from './exec/executor.js';
import { bind } from './plan/binder.js';
import { explainPlan } from './plan/explain.js';
import { optimize } from './plan/optimizer.js';
import { parse } from './sql/parser.js';

export { BindError, CsvError, CsvqlError, ExecutionError, SqlSyntaxError } from './errors.js';

const count = (rows) => `${rows.toLocaleString('en-GB')} ${rows === 1 ? 'row' : 'rows'}`;

async function* flatten(batches) {
  for await (const batch of batches) yield* batch;
}

export class Database {
  //options, all optional:
  //  dir         where table names are looked up (the current directory)
  //  delimiter   the field delimiter (detected for each file)
  //  sampleRows  how many rows are read to infer column types (1000)
  //  chunkSize   how many bytes of a file are read at a time (256 KiB)
  //  optimizer   { rule: false } to switch rules off, or false for all of them
  constructor(options = {}) {
    this.catalog = new Catalog(options);
    this.chunkSize = options.chunkSize;
    this.optimizer = options.optimizer ?? {};
  }

  //parses and plans a query without running it
  async prepare(sql) {
    const statement = parse(sql);
    const { from, joins } = statement.select;
    const refs = from === null ? [] : [from, ...joins.map((join) => join.table)];
    const tables = await Promise.all(refs.map((ref) => this.catalog.resolve(ref)));
    const { plan, columns } = bind(statement.select, tables);
    return { explain: statement.explain, columns, plan: optimize(plan, this.optimizer) };
  }

  //the plan a query would run with, as text. with analyze set the query is
  //run as well, and each line gains the number of rows that node produced and
  //the time it took, which includes the nodes beneath it.
  async explain(sql, { analyze = false } = {}) {
    const { plan } = await this.prepare(sql);
    return analyze ? this.analyze(plan) : explainPlan(plan);
  }

  async analyze(plan) {
    const stats = new Map();
    const started = performance.now();
    let total = 0;
    for await (const batch of execute(plan, { chunkSize: this.chunkSize, stats })) {
      total += batch.length;
    }
    const elapsed = performance.now() - started;
    const note = (node) => {
      const { rows, ms } = stats.get(node);
      return `  [${count(rows)}, ${ms.toFixed(1)} ms]`;
    };
    return `${explainPlan(plan, note)}\n\n${count(total)} in ${elapsed.toFixed(1)} ms`;
  }

  //runs a query and returns { columns, rows } without waiting for the rows.
  //columns is the list of headings, and rows is an async iterable that yields
  //each row as an array, reading the files only as fast as it is consumed.
  async stream(sql) {
    const { explain, plan, columns } = await this.prepare(sql);
    //EXPLAIN returns the plan as a table of one column, a line to a row
    if (explain !== null) {
      const text = explain === 'analyze' ? await this.analyze(plan) : explainPlan(plan);
      const lines = text.split('\n').map((line) => [line]);
      return { columns: ['plan'], rows: flatten([lines]), isPlan: true };
    }
    const batches = execute(plan, { chunkSize: this.chunkSize });
    return { columns, rows: flatten(batches), isPlan: false };
  }

  //runs a query and collects the whole result as { columns, rows }
  async query(sql) {
    const { columns, rows } = await this.stream(sql);
    return { columns, rows: await Array.fromAsync(rows) };
  }

  //the tables in the data directory, as [{ name, file }]
  tables() {
    return this.catalog.tables();
  }

  //what is known about one table:
  //{ name, file, path, columns: [{ name, type }], delimiter, estimatedRows }
  schema(table) {
    return this.catalog.resolve({ name: table, isPath: false, pos: null });
  }
}
