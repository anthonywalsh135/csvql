import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CsvParser } from '../src/csv/parser.js';
import { formatRecord } from '../src/csv/writer.js';
import { CsvError } from '../src/errors.js';
import { createRandom } from './support/random.js';

function parseAll(text, options) {
  return new CsvParser(options).end(text);
}

//feeds the text to a parser in pieces, cut at the given offsets
function parseInPieces(text, cuts, options) {
  const parser = new CsvParser(options);
  const records = [];
  let from = 0;
  for (const cut of [...cuts, text.length]) {
    records.push(...parser.write(text.slice(from, cut)));
    from = cut;
  }
  records.push(...parser.end());
  return records;
}

test('plain fields are split on commas and line breaks', () => {
  assert.deepEqual(parseAll('a,b,c\n1,2,3\n'), [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
});

test('the last record does not need a line break', () => {
  assert.deepEqual(parseAll('a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('windows and old mac line endings are understood', () => {
  const expected = [
    ['a', 'b'],
    ['1', '2'],
  ];
  assert.deepEqual(parseAll('a,b\r\n1,2\r\n'), expected);
  assert.deepEqual(parseAll('a,b\r1,2\r'), expected);
});

test('a quoted field can hold commas, quotes and line breaks', () => {
  assert.deepEqual(parseAll('"Smith, Jo","said ""hi""","two\nlines"\r\n'), [
    ['Smith, Jo', 'said "hi"', 'two\nlines'],
  ]);
});

test('an empty field is null but an empty quoted field is an empty string', () => {
  assert.deepEqual(parseAll('a,,""\n,b,\n'), [
    ['a', null, ''],
    [null, 'b', null],
  ]);
});

test('blank lines are skipped, but a line of empty fields is a record', () => {
  assert.deepEqual(parseAll('a,b\n\n\r\n1,2\n,\n\n'), [
    ['a', 'b'],
    ['1', '2'],
    [null, null],
  ]);
  assert.deepEqual(parseAll('\n\n'), []);
  assert.deepEqual(parseAll(''), []);
});

test('a quoted empty string on its own line is a record, not a blank line', () => {
  assert.deepEqual(parseAll('a\n""\nb\n'), [['a'], [''], ['b']]);
});

test('a quote in the middle of an unquoted field is an ordinary character', () => {
  assert.deepEqual(parseAll('5" nail,a"b"c\n'), [['5" nail', 'a"b"c']]);
});

test('text after a closing quote is kept rather than lost', () => {
  assert.deepEqual(parseAll('"abc"def,x\n'), [['abcdef', 'x']]);
});

test('other delimiters work, and a comma is then ordinary text', () => {
  assert.deepEqual(parseAll('a\tb,c\n"x\ty"\tz\n', { delimiter: '\t' }), [
    ['a', 'b,c'],
    ['x\ty', 'z'],
  ]);
  assert.deepEqual(parseAll('a;b\n', { delimiter: ';' }), [['a', 'b']]);
});

test('only the columns asked for are returned', () => {
  const keep = [true, false, true];
  assert.deepEqual(parseAll('a,b,c\n1,"skipped, ""quoted""",3\n', { keep }), [
    ['a', 'c'],
    ['1', '3'],
  ]);
});

test('with a column list, short rows are padded and long rows are cut', () => {
  const keep = [true, true, true];
  assert.deepEqual(parseAll('1\n1,2,3,4,5\n1,2\n', { keep }), [
    ['1', null, null],
    ['1', '2', '3'],
    ['1', '2', null],
  ]);
});

test('asking for no columns still counts the records', () => {
  assert.deepEqual(parseAll('a,b\n1,2\n3,4\n', { keep: [false, false] }), [[], [], []]);
});

test('a quoted field that never closes is an error naming the record', () => {
  assert.throws(
    () => parseAll('a,b\n1,"oops\n2,3\n'),
    (error) =>
      error instanceof CsvError &&
      /record 2 has a quoted field that is never closed/.test(error.message),
  );
});

test('records are only returned once they are known to be complete', () => {
  const parser = new CsvParser();
  assert.deepEqual(parser.write('a,b\n1,'), [['a', 'b']]);
  assert.deepEqual(parser.write('2'), []);
  assert.deepEqual(parser.write('2\n3'), [['1', '22']]);
  assert.deepEqual(parser.end(',4'), [['3', '4']]);
});

test('a line break split across two chunks is one line break', () => {
  const parser = new CsvParser();
  assert.deepEqual(parser.write('a\r'), []);
  assert.deepEqual(parser.write('\nb\r\n'), [['a'], ['b']]);
  assert.deepEqual(parser.end(), []);
});

test('a doubled quote split across two chunks is one quote', () => {
  const parser = new CsvParser();
  assert.deepEqual(parser.write('"say "'), []);
  assert.deepEqual(parser.write('"hi"""\n'), [['say "hi"']]);
});

test('cutting the input anywhere gives the same records', () => {
  const text = [
    'id,name,note',
    '1,"Smith, Jo","said ""hi"""',
    '2,,""',
    '',
    '3,"two\r\nlines",plain',
    '"4",x"y,"tail"end',
    ',,',
    '5,last,',
  ].join('\r\n');
  const whole = parseAll(text);
  assert.equal(whole.length, 7);

  for (let cut = 0; cut <= text.length; cut++) {
    assert.deepEqual(parseInPieces(text, [cut]), whole, `cut at ${cut}`);
  }
  for (let first = 0; first < text.length; first += 3) {
    for (let second = first; second < text.length; second += 5) {
      assert.deepEqual(parseInPieces(text, [first, second]), whole, `cuts at ${first}, ${second}`);
    }
  }
  //one character at a time
  const everyOffset = Array.from({ length: text.length }, (_, index) => index);
  assert.deepEqual(parseInPieces(text, everyOffset), whole);
});

test('random tables survive being written, cut up and read back', () => {
  const random = createRandom(20261110);
  const alphabet = ['a', 'B', '7', ' ', ',', '"', '\n', '\r', ';', 'é', '\t', '-'];

  for (let round = 0; round < 300; round++) {
    const delimiter = random.pick([',', ';', '\t']);
    const newline = random.pick(['\n', '\r\n']);
    const width = random.int(2, 5);
    const rows = Array.from({ length: random.int(0, 8) }, () =>
      Array.from({ length: width }, () => {
        if (random.chance(0.15)) return null;
        const length = random.int(0, 6);
        return Array.from({ length }, () => random.pick(alphabet)).join('');
      }),
    );

    let text = rows.map((row) => formatRecord(row, delimiter)).join(newline);
    if (rows.length > 0 && random.chance(0.5)) text += newline;

    const cuts = Array.from({ length: random.int(0, 6) }, () => random.int(0, text.length));
    cuts.sort((a, b) => a - b);
    assert.deepEqual(parseInPieces(text, cuts, { delimiter }), rows, `round ${round}`);
  }
});

test('the writer quotes only what needs it', () => {
  assert.equal(
    formatRecord(['plain', 'a,b', 'say "hi"', 'two\nlines', '', null, 42, true]),
    'plain,"a,b","say ""hi""","two\nlines","",,42,true',
  );
  assert.equal(formatRecord(['a,b', 'c\td'], '\t'), 'a,b\t"c\td"');
});
