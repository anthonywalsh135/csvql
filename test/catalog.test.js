import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { Catalog } from '../src/catalog.js';
import { BindError } from '../src/errors.js';
import { closestMatch, didYouMean } from '../src/suggest.js';
import { tempDir } from './support/files.js';

const byName = (name, pos = 0) => ({ name, isPath: false, alias: null, pos });
const byPath = (name, pos = 0) => ({ name, isPath: true, alias: null, pos });

function bindError(message, position) {
  return (error) => {
    assert.ok(error instanceof BindError, `expected a bind error, got ${error}`);
    assert.match(error.message, message);
    if (position !== undefined) assert.equal(error.position, position);
    return true;
  };
}

test('a bare table name is looked up as a csv file in the data directory', async (t) => {
  const dir = await tempDir(t, { 'people.csv': 'id,name\n1,Ada\n2,Grace\n' });
  const table = await new Catalog({ dir }).resolve(byName('people'));
  assert.deepEqual(table, {
    name: 'people',
    file: 'people.csv',
    path: join(dir, 'people.csv'),
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'text' },
    ],
    delimiter: ',',
    estimatedRows: 2,
  });
});

test('table names ignore case and also match tsv files', async (t) => {
  const dir = await tempDir(t, { 'People.csv': 'id\n1\n', 'cities.TSV': 'name\tsize\nLeeds\t1\n' });
  const catalog = new Catalog({ dir });
  assert.equal((await catalog.resolve(byName('PEOPLE'))).file, 'People.csv');
  const cities = await catalog.resolve(byName('cities'));
  assert.equal(cities.delimiter, '\t');
  assert.equal(cities.columns.length, 2);
});

test('a quoted path is used as given, relative to the data directory', async (t) => {
  const dir = await tempDir(t);
  await mkdir(join(dir, 'archive'));
  await writeFile(join(dir, 'archive', 'old sales.csv'), 'total\n10\n');
  const catalog = new Catalog({ dir });

  const relative = await catalog.resolve(byPath('archive/old sales.csv'));
  assert.equal(relative.name, 'old sales');
  assert.equal(relative.path, join(dir, 'archive', 'old sales.csv'));

  const absolute = await catalog.resolve(byPath(join(dir, 'archive', 'old sales.csv')));
  assert.equal(absolute, relative, 'the same file is described once');
});

test('an unknown table is an error that offers the nearest name', async (t) => {
  const dir = await tempDir(t, { 'customers.csv': 'id\n1\n', 'orders.csv': 'id\n1\n' });
  const catalog = new Catalog({ dir });
  await assert.rejects(
    catalog.resolve(byName('custmers', 14)),
    bindError(/table "custmers" was not found in .*; did you mean "customers"\?/, 14),
  );
  await assert.rejects(catalog.resolve(byName('invoices')), (error) => {
    assert.doesNotMatch(error.message, /did you mean/);
    return true;
  });
});

test('a name that matches two files has to be written as a path', async (t) => {
  const dir = await tempDir(t, { 'sales.csv': 'a\n1\n', 'sales.tsv': 'a\n1\n' });
  await assert.rejects(
    new Catalog({ dir }).resolve(byName('sales', 9)),
    bindError(/table "sales" could be sales\.csv or sales\.tsv/, 9),
  );
});

test('a path with nothing at it, or a directory at it, is an error', async (t) => {
  const dir = await tempDir(t);
  await mkdir(join(dir, 'folder.csv'));
  const catalog = new Catalog({ dir });
  await assert.rejects(
    catalog.resolve(byPath('missing.csv', 5)),
    bindError(/there is no file at/, 5),
  );
  await assert.rejects(catalog.resolve(byPath('folder.csv')), bindError(/there is no file at/));
});

test('a file is described once and described again after it changes', async (t) => {
  const dir = await tempDir(t, { 't.csv': 'a\n1\n' });
  const catalog = new Catalog({ dir });
  const first = await catalog.resolve(byName('t'));
  assert.equal(await catalog.resolve(byName('t')), first);

  await writeFile(join(dir, 't.csv'), 'a,b\nx,2\ny,3\n');
  const second = await catalog.resolve(byName('t'));
  assert.notEqual(second, first);
  assert.deepEqual(
    second.columns.map((column) => [column.name, column.type]),
    [
      ['a', 'text'],
      ['b', 'integer'],
    ],
  );
});

test('options for reading files are passed through', async (t) => {
  const dir = await tempDir(t, { 't.csv': 'a|b\n1|2\n' });
  const table = await new Catalog({ dir, delimiter: ',' }).resolve(byName('t'));
  assert.deepEqual(
    table.columns.map((column) => column.name),
    ['a|b'],
  );
});

test('the tables of a directory are its csv and tsv files, in order', async (t) => {
  const dir = await tempDir(t, {
    'b.csv': 'x\n',
    'a.tsv': 'x\n',
    'notes.txt': 'x\n',
    'c.CSV': 'x\n',
  });
  await mkdir(join(dir, 'd.csv'));
  assert.deepEqual(await new Catalog({ dir }).tables(), [
    { name: 'a', file: 'a.tsv' },
    { name: 'b', file: 'b.csv' },
    { name: 'c', file: 'c.CSV' },
  ]);
});

test('a data directory that does not exist is reported as such', async (t) => {
  const dir = await tempDir(t);
  const catalog = new Catalog({ dir: join(dir, 'nowhere') });
  await assert.rejects(catalog.tables(), bindError(/cannot read the data directory/));
  await assert.rejects(catalog.resolve(byName('t')), bindError(/cannot read the data directory/));
});

test('the nearest name is found within a third of its length in edits', () => {
  const names = ['customers', 'orders', 'products'];
  assert.equal(closestMatch('custmers', names), 'customers');
  assert.equal(closestMatch('ORDER', names), 'orders');
  assert.equal(closestMatch('prodcuts', names), 'products');
  assert.equal(closestMatch('invoices', names), null);
  assert.equal(closestMatch('id', ['if', 'name']), 'if');
  assert.equal(closestMatch('x', []), null);
});

test('a suggestion is phrased to be added to the end of a message', () => {
  assert.equal(didYouMean('nmae', ['name', 'age']), '; did you mean "name"?');
  assert.equal(didYouMean('zzz', ['name', 'age']), '');
});
