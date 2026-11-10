import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { formatTable, render } from '../src/cli/render.js';
import { tempDir } from './support/files.js';
import { ORDERS, PEOPLE } from './support/fixtures.js';
import { run } from './support/streams.js';

const data = (t, files = {}) =>
  tempDir(t, { 'people.csv': PEOPLE, 'orders.csv': ORDERS, ...files });

async function rendered(format, columns, rows) {
  const pieces = await Array.fromAsync(render(format, { columns, rows }));
  return pieces.join('');
}

test('a table lines its columns up and sets numbers to the right', () => {
  const rows = [
    ['Ada', 36, 1.5],
    ['Barbara', null, 12.25],
    ['Zoë', 7, null],
  ];
  assert.equal(
    formatTable(['name', 'age', 'score'], rows),
    [
      ' name    | age  | score',
      '---------+------+-------',
      ' Ada     |   36 |   1.5',
      ' Barbara | NULL | 12.25',
      ' Zoë     |    7 |  NULL',
      '(3 rows)',
    ].join('\n'),
  );
});

test('a table copes with no rows, one row and awkward values', () => {
  assert.equal(formatTable(['a', 'b'], []), [' a | b', '---+---', '(0 rows)'].join('\n'));
  assert.equal(
    formatTable(['note', 'ok'], [['two\nlines\tand a tab', true]]),
    [
      ' note                  | ok',
      '-----------------------+------',
      ' two\\nlines\\tand a tab | true',
      '(1 row)',
    ].join('\n'),
  );
});

test('csv output can be read back as the same values', async () => {
  const rows = [
    [1, 'plain', null],
    [2, 'has, comma', ''],
    [3, 'has "quotes"', true],
  ];
  assert.equal(
    await rendered('csv', ['id', 'text', 'flag'], rows),
    'id,text,flag\n1,plain,\n2,"has, comma",""\n3,"has ""quotes""",true\n',
  );
});

test('json output is an array of objects, one to a line', async () => {
  const text = await rendered(
    'json',
    ['id', 'name', 'id'],
    [
      [1, 'Ada', 10],
      [2, null, 20],
    ],
  );
  assert.equal(
    text,
    '[\n  {"id":1,"name":"Ada","id_2":10},\n  {"id":2,"name":null,"id_2":20}\n]\n',
  );
  assert.equal(await rendered('json', ['id'], []), '[]\n');
});

test('a query given as an argument prints a table', async (t) => {
  const dir = await data(t);
  const result = await run([
    '--dir',
    dir,
    'SELECT name, age FROM people WHERE age > 40 ORDER BY age',
  ]);
  assert.deepEqual(result, {
    status: 0,
    stdout: [' name  | age', '-------+-----', ' Alan  |  41', ' Grace |  45', '(2 rows)', ''].join(
      '\n',
    ),
    stderr: '',
  });
});

test('the output format can be chosen', async (t) => {
  const dir = await data(t);
  const sql = 'SELECT id, city FROM people WHERE id >= 4';
  assert.equal((await run(['-d', dir, '-o', 'csv', sql])).stdout, 'id,city\n4,Rotterdam\n5,\n');
  assert.equal(
    (await run(['-d', dir, '--format', 'json', sql])).stdout,
    '[\n  {"id":4,"city":"Rotterdam"},\n  {"id":5,"city":null}\n]\n',
  );
});

test('queries can come from a file or from standard input', async (t) => {
  const dir = await data(t, {
    'report.sql': '-- two statements\nSELECT COUNT(*) AS n FROM people;\nSELECT 1 + 1 AS two;\n',
  });
  const fromFile = await run(['-d', dir, '-f', join(dir, 'report.sql')]);
  assert.equal(fromFile.status, 0);
  assert.equal(
    fromFile.stdout,
    [' n', '---', ' 5', '(1 row)', '', ' two', '-----', '   2', '(1 row)', ''].join('\n'),
  );

  const piped = await run(['-d', dir, '-o', 'csv'], 'SELECT MAX(age) FROM people');
  assert.equal(piped.stdout, 'MAX(age)\n45\n');
});

test('EXPLAIN prints the plan as it is, without a table around it', async (t) => {
  const dir = await data(t);
  const { stdout } = await run(['-d', dir, 'EXPLAIN SELECT name FROM people LIMIT 2']);
  assert.equal(
    stdout,
    ['Project name', '└─ Limit 2', '   └─ Scan people.csv (name) ~5 rows', ''].join('\n'),
  );
});

test('the optimiser can be switched off', async (t) => {
  const dir = await data(t);
  const sql = 'EXPLAIN SELECT p.name FROM people p, orders o WHERE o.person_id = p.id';
  assert.match((await run(['-d', dir, sql])).stdout, /Hash join/);
  const plain = await run(['-d', dir, '--no-optimize', sql]);
  assert.match(plain.stdout, /Cross join/);
  assert.match(plain.stdout, /Filter o\.person_id = p\.id/);
});

test('the delimiter can be forced, with \\t standing for a tab', async (t) => {
  const dir = await data(t, { 'odd.csv': 'a\tb,c\n1\t2,3\n' });
  assert.equal(
    (await run(['-d', dir, '-o', 'csv', '--delimiter', '\\t', 'SELECT a FROM odd'])).stdout,
    'a\n1\n',
  );
  assert.equal(
    (await run(['-d', dir, '-o', 'csv', '--delimiter', ',', 'SELECT c FROM odd'])).stdout,
    'c\n3\n',
  );
});

test('a mistake in the query is shown with a caret and fails the command', async (t) => {
  const dir = await data(t);
  const result = await run(['-d', dir, 'SELECT nmae FROM people']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    [
      'error: unknown column "nmae"; did you mean "name"?',
      '  SELECT nmae FROM people',
      '         ^',
      '',
    ].join('\n'),
  );
  const syntax = await run(['-d', dir, 'SELECT * FROM people WHERE']);
  assert.equal(syntax.status, 1);
  assert.match(syntax.stderr, /^error: expected an expression but found the end of the query\n/);
});

test('a script stops at the first statement that fails', async (t) => {
  const dir = await data(t);
  const result = await run([
    '-d',
    dir,
    '-o',
    'csv',
    'SELECT 1 AS a; SELECT name + 1 FROM people; SELECT 2 AS b',
  ]);
  assert.equal(result.status, 1);
  //nothing of the failed statement is printed, not even its heading
  assert.equal(result.stdout, 'a\n1\n');
  assert.match(result.stderr, /^error: cannot apply \+ to the text 'Ada' and the number 1\n$/);
});

test('misuse of the command is told apart from a failing query', async (t) => {
  const dir = await data(t);
  const cases = [
    [['--frmat', 'csv', 'SELECT 1'], /Unknown option '--frmat'/],
    [['-o', 'xml', 'SELECT 1'], /unknown format "xml"; use table, csv, json/],
    [['SELECT 1', 'SELECT 2'], /expected one query; put it in quotes/],
    [['-f', 'x.sql', 'SELECT 1'], /a query or a file of queries, not both/],
    [[], /no query given/],
  ];
  for (const [args, message] of cases) {
    const result = await run(['-d', dir, ...args]);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, message);
    assert.match(result.stderr, /try "csvql --help"\n$/);
  }
  const missing = await run(['-f', join(dir, 'nothing.sql')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read .*nothing\.sql/);
});

test('help and version', async () => {
  const help = await run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: csvql \[options\] "<query>"/);
  assert.match(help.stdout, /--no-optimize/);
  const version = await run(['-v']);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('the installed command runs end to end', async (t) => {
  const dir = await data(t);
  const bin = join(import.meta.dirname, '..', 'bin', 'csvql.js');
  const sql = 'SELECT city, COUNT(*) AS n FROM people GROUP BY city ORDER BY n DESC, city LIMIT 1';
  const { stdout } = await promisify(execFile)(process.execPath, [
    bin,
    '-d',
    dir,
    '-o',
    'csv',
    sql,
  ]);
  assert.equal(stdout, 'city,n\nLondon,2\n');
  await assert.rejects(
    promisify(execFile)(process.execPath, [bin, '-d', dir, 'SELECT']),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /^error: expected an expression/);
      return true;
    },
  );
});
