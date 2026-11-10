//the public interface: a Database is a directory of csv files that can be
//queried with sql.
//
//  const db = new Database({ dir: './data' });
//  const { columns, rows } = await db.query('SELECT name FROM people LIMIT 3');

import { Catalog } from './catalog.js';
import { execute } from './exec/executor.js';
import { bind } from './plan/binder.js';
import { parse } from './sql/parser.js';

export { BindError, CsvError, CsvqlError, ExecutionError, SqlSyntaxError } from './errors.js';

export class Database {
  //options, all optional:
  //  dir         where table names are looked up (the current directory)
  //  delimiter   the field delimiter (detected for each file)
  //  sampleRows  how many rows are read to infer column types (1000)
  //  chunkSize   how many bytes of a file are read at a time (256 KiB)
  constructor(options = {}) {
    this.catalog = new Catalog(options);
    this.chunkSize = options.chunkSize;
  }

  //parses and plans a query without running it
  async prepare(sql) {
    const statement = parse(sql);
    const { from, joins } = statement.select;
    const refs = from === null ? [] : [from, ...joins.map((join) => join.table)];
    const tables = await Promise.all(refs.map((ref) => this.catalog.resolve(ref)));
    return bind(statement.select, tables);
  }

  //runs a query and returns { columns, rows } without waiting for the rows.
  //columns is the list of headings, and rows is an async iterable that yields
  //each row as an array, reading the files only as fast as it is consumed.
  async stream(sql) {
    const { plan, columns } = await this.prepare(sql);
    const batches = execute(plan, { chunkSize: this.chunkSize });
    async function* rows() {
      for await (const batch of batches) yield* batch;
    }
    return { columns, rows: rows() };
  }

  //runs a query and collects the whole result as { columns, rows }
  async query(sql) {
    const { columns, rows } = await this.stream(sql);
    return { columns, rows: await Array.fromAsync(rows) };
  }
}
