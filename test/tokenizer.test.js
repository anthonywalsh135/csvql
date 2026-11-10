import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqlSyntaxError } from '../src/errors.js';
import { tokenize } from '../src/sql/tokenizer.js';

//the type and value of each token, without the trailing end marker
function summary(sql) {
  return tokenize(sql)
    .slice(0, -1)
    .map((token) => [token.type, token.value]);
}

function syntaxError(sql, message, position) {
  assert.throws(
    () => tokenize(sql),
    (error) => {
      assert.ok(error instanceof SqlSyntaxError);
      assert.match(error.message, message);
      assert.equal(error.position, position);
      return true;
    },
  );
}

test('keywords are recognised in any case and reported in upper case', () => {
  assert.deepEqual(summary('select Name fRoM people'), [
    ['keyword', 'SELECT'],
    ['identifier', 'Name'],
    ['keyword', 'FROM'],
    ['identifier', 'people'],
  ]);
});

test('every token records where it starts and ends', () => {
  const tokens = tokenize('a  >= 10');
  assert.deepEqual(
    tokens.map((token) => [token.start, token.end]),
    [
      [0, 1],
      [3, 5],
      [6, 8],
      [8, 8],
    ],
  );
  assert.equal(tokens.at(-1).type, 'end');
});

test('numbers can be integers, decimals or use an exponent', () => {
  assert.deepEqual(
    summary('42 3.14 .5 7. 1e3 2.5E-2').map(([, value]) => value),
    [42, 3.14, 0.5, 7, 1000, 0.025],
  );
});

test('a dot between two names is an operator, not the start of a number', () => {
  assert.deepEqual(summary('t1.c2'), [
    ['identifier', 't1'],
    ['operator', '.'],
    ['identifier', 'c2'],
  ]);
});

test('two-character operators are not split in half', () => {
  assert.deepEqual(
    summary('a<=b<>c!=d>=e||f<g').filter(([type]) => type === 'operator'),
    ['<=', '<>', '!=', '>=', '||', '<'].map((op) => ['operator', op]),
  );
});

test('a doubled quote inside a string is one quote', () => {
  assert.deepEqual(summary("'it''s' ''"), [
    ['string', "it's"],
    ['string', ''],
  ]);
});

test('quoted names keep their spelling and are never keywords', () => {
  const tokens = tokenize('"order" [first name] "say ""hi"""');
  assert.deepEqual(
    tokens.slice(0, -1).map((token) => [token.type, token.value, token.quoted]),
    [
      ['identifier', 'order', true],
      ['identifier', 'first name', true],
      ['identifier', 'say "hi"', true],
    ],
  );
});

test('names can use letters from any alphabet', () => {
  assert.deepEqual(summary('café_2 naïve$'), [
    ['identifier', 'café_2'],
    ['identifier', 'naïve$'],
  ]);
});

test('comments are skipped', () => {
  assert.deepEqual(summary('1 -- to the end of the line\n+ /* in\nline */ 2 -- at the end'), [
    ['number', 1],
    ['operator', '+'],
    ['number', 2],
  ]);
});

test('empty and blank input produce only the end token', () => {
  assert.deepEqual(summary(''), []);
  assert.deepEqual(summary(' \n\t '), []);
  assert.equal(tokenize('  ').at(-1).start, 2);
});

test('an unclosed string points at its opening quote', () => {
  syntaxError("SELECT 'abc", /string is never closed/, 7);
  syntaxError('SELECT "abc', /quoted name is never closed/, 7);
  syntaxError('SELECT [abc', /quoted name is never closed/, 7);
});

test('an unclosed comment points at where it opens', () => {
  syntaxError('1 /* oops', /comment is never closed/, 2);
});

test('characters outside the language are rejected', () => {
  syntaxError('SELECT @x', /unexpected character "@"/, 7);
  syntaxError('a ! b', /unexpected character "!"/, 2);
});

test('a number that runs into a name is rejected', () => {
  syntaxError('SELECT 12abc', /cannot be followed directly by a letter/, 7);
});

test('a quoted name must not be empty', () => {
  syntaxError('SELECT ""', /cannot be empty/, 7);
});
