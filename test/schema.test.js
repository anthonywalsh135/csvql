import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { readRecords } from '../src/csv/reader.js';
import { detectDelimiter, inferSchema } from '../src/csv/schema.js';
import { converterFor, inferType } from '../src/csv/types.js';
import { CsvError } from '../src/errors.js';
import { tempDir } from './support/files.js';

async function collect(batches) {
  const records = [];
  for await (const batch of batches) records.push(...batch);
  return records;
}

test('a column is given the narrowest type that fits every value', () => {
  assert.equal(inferType(['1', '-20', '0']), 'integer');
  assert.equal(inferType(['1', '2.5', '-3']), 'real');
  assert.equal(inferType(['1e3', '.5', '7.', '-2.5E-3']), 'real');
  assert.equal(inferType(['true', 'FALSE', 'True']), 'boolean');
  assert.equal(inferType(['1', 'two', '3']), 'text');
  assert.equal(inferType(['true', '1']), 'text');
  assert.equal(inferType([]), 'text');
});

test('values that only look like numbers stay as text', () => {
  assert.equal(inferType(['02134', '10001']), 'text', 'leading zeros');
  assert.equal(inferType(['4929123456789012']), 'text', 'too long to be exact');
  assert.equal(inferType(['1,234']), 'text');
  assert.equal(inferType(['+5']), 'text');
  assert.equal(inferType(['0x1F']), 'text');
  assert.equal(inferType([' 5']), 'text');
  assert.equal(inferType(['Infinity', 'NaN']), 'text');
  assert.equal(inferType(['-']), 'text');
});

test('integer fields are converted, and anything else is left alone', () => {
  const convert = converterFor('integer');
  assert.equal(convert('42'), 42);
  assert.equal(convert('-7'), -7);
  assert.equal(convert('0'), 0);
  assert.ok(Object.is(convert('-0'), 0), 'no negative zero');
  assert.equal(convert('999999999999999'), 999999999999999);
  assert.equal(convert('3.5'), 3.5, 'a decimal in an integer column is still a number');
  assert.equal(convert('1e3'), 1000);
  assert.equal(convert('007'), '007');
  assert.equal(convert('n/a'), 'n/a');
  assert.equal(convert('12a'), '12a');
  assert.equal(convert('-'), '-');
  assert.equal(convert(''), '');
  assert.equal(convert('1234567890123456'), '1234567890123456');
});

test('real fields are converted only when they are written as numbers', () => {
  const convert = converterFor('real');
  assert.equal(convert('2.50'), 2.5);
  assert.equal(convert('-.5'), -0.5);
  assert.equal(convert('6'), 6);
  assert.equal(convert('1E-2'), 0.01);
  for (const text of ['', ' 1.5', '0x10', 'Infinity', '1.2.3', '£5.00']) {
    assert.equal(convert(text), text);
  }
});

test('boolean fields are read in any case', () => {
  const convert = converterFor('boolean');
  assert.equal(convert('true'), true);
  assert.equal(convert('false'), false);
  assert.equal(convert('TRUE'), true);
  assert.equal(convert('False'), false);
  assert.equal(convert('yes'), 'yes');
});

test('text columns need no conversion', () => {
  assert.equal(converterFor('text'), null);
});

test('the delimiter is the candidate that splits the header most', () => {
  assert.equal(detectDelimiter('id,name,city'), ',');
  assert.equal(detectDelimiter('id;name;city'), ';');
  assert.equal(detectDelimiter('id\tname\tcity'), '\t');
  assert.equal(detectDelimiter('id|name|city'), '|');
  assert.equal(detectDelimiter('"last, first";age;city'), ';');
  assert.equal(detectDelimiter('only'), ',');
  assert.equal(detectDelimiter(''), ',');
});

test('a schema has a name and a type for each column', async (t) => {
  const dir = await tempDir(t, {
    'people.csv': 'id,name,height,member,joined\n1,Ada,1.65,true,2024-01-05\n2,Grace,,false,\n',
  });
  const schema = await inferSchema(join(dir, 'people.csv'));
  assert.deepEqual(schema, {
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'text' },
      { name: 'height', type: 'real' },
      { name: 'member', type: 'boolean' },
      { name: 'joined', type: 'text' },
    ],
    delimiter: ',',
    estimatedRows: 2,
  });
});

test('the delimiter is detected unless one is given', async (t) => {
  const dir = await tempDir(t, { 'a.csv': 'x;y\n1;2\n', 'b.csv': 'x;y,z\n1;2,3\n' });
  const detected = await inferSchema(join(dir, 'a.csv'));
  assert.equal(detected.delimiter, ';');
  assert.deepEqual(
    detected.columns.map((column) => column.name),
    ['x', 'y'],
  );

  const forced = await inferSchema(join(dir, 'b.csv'), { delimiter: ';' });
  assert.deepEqual(
    forced.columns.map((column) => column.name),
    ['x', 'y,z'],
  );
});

test('blank and repeated column names are made usable', async (t) => {
  const dir = await tempDir(t, { 't.csv': 'id,,Name, name ,ID,\n1,2,3,4,5,6\n' });
  const { columns } = await inferSchema(join(dir, 't.csv'));
  assert.deepEqual(
    columns.map((column) => column.name),
    ['id', 'column_2', 'Name', 'name_2', 'ID_2', 'column_6'],
  );
});

test('a byte order mark is not part of the first column name', async (t) => {
  const dir = await tempDir(t, { 't.csv': '﻿id,name\n1,a\n' });
  const { columns } = await inferSchema(join(dir, 't.csv'));
  assert.equal(columns[0].name, 'id');
});

test('a file with only a header has text columns and no rows', async (t) => {
  const dir = await tempDir(t, { 't.csv': 'a,b\n' });
  assert.deepEqual(await inferSchema(join(dir, 't.csv')), {
    columns: [
      { name: 'a', type: 'text' },
      { name: 'b', type: 'text' },
    ],
    delimiter: ',',
    estimatedRows: 0,
  });
});

test('an empty file has no header and is an error', async (t) => {
  const dir = await tempDir(t, { 'empty.csv': '', 'blank.csv': '\n\n' });
  for (const name of ['empty.csv', 'blank.csv']) {
    await assert.rejects(inferSchema(join(dir, name)), (error) => {
      assert.ok(error instanceof CsvError);
      assert.match(error.message, new RegExp(`${name} is empty`));
      return true;
    });
  }
});

test('rows shorter than the header do not upset type inference', async (t) => {
  const dir = await tempDir(t, { 't.csv': 'a,b,c\n1\n2,x\n3,y,4.5\n' });
  const { columns } = await inferSchema(join(dir, 't.csv'));
  assert.deepEqual(
    columns.map((column) => column.type),
    ['integer', 'text', 'real'],
  );
});

test('types come from the sample, so a late surprise does not change them', async (t) => {
  const lines = ['n'];
  for (let i = 0; i < 50; i++) lines.push(String(i));
  lines.push('not a number');
  const dir = await tempDir(t, { 't.csv': lines.join('\n') });
  const sampled = await inferSchema(join(dir, 't.csv'), { sampleRows: 10, chunkSize: 16 });
  assert.equal(sampled.columns[0].type, 'integer');
  const whole = await inferSchema(join(dir, 't.csv'));
  assert.equal(whole.columns[0].type, 'text');
});

test('the row count of a large file is estimated from the sample', async (t) => {
  const lines = ['id,city,amount'];
  for (let i = 0; i < 20000; i++)
    lines.push(`${i},${i % 7 === 0 ? 'Southampton' : 'Leeds'},${i * 1.5}`);
  const dir = await tempDir(t, { 'big.csv': lines.join('\n') + '\n' });
  const { estimatedRows } = await inferSchema(join(dir, 'big.csv'));
  assert.notEqual(estimatedRows, 20000, 'this file is too big to have been counted');
  assert.ok(Math.abs(estimatedRows - 20000) < 2000, `estimate of ${estimatedRows} is too far out`);
});

test('reading in tiny chunks gives the same records as reading in one', async (t) => {
  const text =
    'id,name,note\r\n1,"Zoë, Åsa","日本語 ""quoted"""\r\n2,😀 emoji,\r\n3,plain,"two\nlines"';
  const dir = await tempDir(t, { 't.csv': text });
  const path = join(dir, 't.csv');
  const whole = await collect(readRecords(path));
  assert.deepEqual(whole, [
    ['id', 'name', 'note'],
    ['1', 'Zoë, Åsa', '日本語 "quoted"'],
    ['2', '😀 emoji', null],
    ['3', 'plain', 'two\nlines'],
  ]);
  //small enough that multi-byte characters are cut in half
  for (const chunkSize of [1, 2, 3, 5, 7, 16]) {
    assert.deepEqual(
      await collect(readRecords(path, { chunkSize })),
      whole,
      `chunks of ${chunkSize}`,
    );
  }
});

test('the reader strips a byte order mark and honours the column list', async (t) => {
  const dir = await tempDir(t, { 't.csv': '﻿a,b,c\n1,2,3\n' });
  const records = await collect(
    readRecords(join(dir, 't.csv'), { keep: [true, false, true], chunkSize: 2 }),
  );
  assert.deepEqual(records, [
    ['a', 'c'],
    ['1', '3'],
  ]);
});

test('the reader counts the bytes it has consumed', async (t) => {
  const text = 'a,b\n' + '1,2\n'.repeat(500);
  const dir = await tempDir(t, { 't.csv': text });
  const progress = { bytesRead: 0 };
  await collect(readRecords(join(dir, 't.csv'), { chunkSize: 64, progress }));
  assert.equal(progress.bytesRead, text.length);
});

test('a caller that stops early stops the file being read', async (t) => {
  const text = 'a,b\n' + '1,2\n'.repeat(5000);
  const dir = await tempDir(t, { 't.csv': text });
  const progress = { bytesRead: 0 };
  for await (const batch of readRecords(join(dir, 't.csv'), { chunkSize: 128, progress })) {
    assert.ok(batch.length > 0);
    break;
  }
  assert.ok(progress.bytesRead < text.length / 10, `read ${progress.bytesRead} bytes`);
});
