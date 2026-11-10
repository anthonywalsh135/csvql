import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { main } from '../src/cli/main.js';
import { startShell } from '../src/cli/shell.js';
import { shop } from './support/fixtures.js';
import { capture } from './support/streams.js';

//types the given lines into a shell and returns everything it printed
async function session(t, lines, options) {
  const db = await shop(t, options);
  const input = new PassThrough();
  const output = capture();
  input.end(`${lines.join('\n')}\n`);
  const status = await startShell({ db, input, output: output.stream });
  assert.equal(status, 0);
  return output.text();
}

test('a statement is run when a line ends with a semicolon', async (t) => {
  const printed = await session(t, [
    'SELECT name',
    '  FROM people',
    '  WHERE age > 40',
    '  ORDER BY name;',
  ]);
  assert.match(printed, /^csvql shell\. Type \.help for help\.\n/);
  assert.match(printed, / name\n-------\n Alan\n Grace\n\(2 rows\)\n[\d.]+ ms\n/);
});

test('several statements can be run one after another', async (t) => {
  const printed = await session(t, [
    'SELECT COUNT(*) AS n FROM people;',
    '',
    'SELECT 1 + 1 AS two; SELECT 3 AS three;',
  ]);
  assert.match(printed, / n\n---\n 5\n\(1 row\)/);
  assert.match(printed, / two\n-----\n {3}2\n\(1 row\)\n\n three\n-------\n {5}3\n\(1 row\)/);
});

test('a mistake is reported and the shell carries on', async (t) => {
  const printed = await session(t, ['SELECT nmae FROM people;', 'SELECT 42 AS answer;']);
  assert.match(
    printed,
    /error: unknown column "nmae"; did you mean "name"\?\n {2}SELECT nmae FROM people\n {9}\^\n/,
  );
  assert.match(printed, / answer\n--------\n {5}42\n/);
});

test('.tables lists the tables with their size', async (t) => {
  const printed = await session(t, ['.tables']);
  assert.match(printed, /orders {2}~6 rows, 4 columns\npeople {2}~5 rows, 5 columns\n/);
});

test('.schema shows the columns of a table and their types', async (t) => {
  const printed = await session(t, ['.schema people', '.schema', '.schema nothing']);
  assert.match(
    printed,
    /people\.csv, ~5 rows\n {2}id {6}integer\n {2}name {4}text\n {2}city {4}text\n {2}age {5}integer\n {2}member {2}boolean\n/,
  );
  assert.match(printed, /usage: \.schema <table>\n/);
  assert.match(printed, /error: table "nothing" was not found/);
});

test('.help explains, unknown commands are refused and .quit leaves', async (t) => {
  const printed = await session(t, ['.help', '.frobnicate', '.quit', 'SELECT 1 AS never;']);
  assert.match(printed, /\.schema <table> {2}show the columns/);
  assert.match(printed, /unknown command \.frobnicate; try \.help\n/);
  assert.doesNotMatch(printed, /never/);
});

test('an empty data directory is said to be empty', async (t) => {
  const db = await shop(t);
  db.tables = async () => [];
  const input = new PassThrough();
  const output = capture();
  input.end('.tables\n');
  await startShell({ db, input, output: output.stream });
  assert.match(output.text(), /there are no csv files in the data directory\n/);
});

test('the command opens the shell when run from a terminal with no query', async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = capture();
  stdin.end('SELECT 6 * 7 AS answer;\n.quit\n');
  const status = await main([], { stdin, stdout: stdout.stream, stderr: capture().stream });
  assert.equal(status, 0);
  assert.match(stdout.text(), / answer\n--------\n {5}42\n/);
});
