//the catalog maps the table names in a query onto files on disk, and remembers
//what it has learnt about each file, so that a session of queries reads each
//header once.

import { readdir, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import { inferSchema } from './csv/schema.js';
import { BindError } from './errors.js';
import { didYouMean } from './suggest.js';

const EXTENSIONS = new Set(['.csv', '.tsv']);

export class Catalog {
  constructor({ dir = process.cwd(), delimiter = null, sampleRows, chunkSize } = {}) {
    this.dir = resolve(dir);
    this.schemaOptions = { delimiter, sampleRows, chunkSize };
    this.cache = new Map();
  }

  //every table in the data directory, as [{ name, file }]
  async tables() {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => {
      throw new BindError(`cannot read the data directory ${this.dir}`);
    });
    return entries
      .filter((entry) => entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => ({ name: basename(entry.name, extname(entry.name)), file: entry.name }))
      .sort((a, b) => (a.file < b.file ? -1 : 1));
  }

  //describes the file a table reference points at. the reference is the
  //parser's table node: a bare name to look up in the data directory, or a
  //path. the result is { name, file, path, columns, delimiter, estimatedRows }.
  async resolve(ref) {
    const path = ref.isPath ? resolve(this.dir, ref.name) : await this.find(ref);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) {
      throw new BindError(`there is no file at ${path}`, ref.pos);
    }

    //a file that has been edited since it was last seen is looked at again
    const cached = this.cache.get(path);
    if (cached && cached.modified === info.mtimeMs && cached.size === info.size) {
      return cached.table;
    }

    const schema = await inferSchema(path, this.schemaOptions);
    const file = basename(path);
    const table = { name: basename(file, extname(file)), file, path, ...schema };
    this.cache.set(path, { modified: info.mtimeMs, size: info.size, table });
    return table;
  }

  async find(ref) {
    const tables = await this.tables();
    const wanted = ref.name.toLowerCase();
    let matches = tables.filter((table) => table.name.toLowerCase() === wanted);
    //where file names are case sensitive, orders.csv and Orders.csv can both
    //exist, and the one spelt the way the query spells it wins
    if (matches.length > 1) {
      const exact = matches.filter((table) => table.name === ref.name);
      if (exact.length > 0) matches = exact;
    }

    if (matches.length === 0) {
      const hint = didYouMean(
        ref.name,
        tables.map((table) => table.name),
      );
      throw new BindError(`table "${ref.name}" was not found in ${this.dir}${hint}`, ref.pos);
    }
    if (matches.length > 1) {
      const files = matches.map((table) => table.file).join(' or ');
      const message = `table "${ref.name}" could be ${files}; name the file in quotes instead`;
      throw new BindError(message, ref.pos);
    }
    return resolve(this.dir, matches[0].file);
  }
}
