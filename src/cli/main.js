//the command line. it reads the arguments, runs the queries and writes the
//results. everything it touches is passed in, so the tests can run it without
//a terminal or a child process.

import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';

import { describeError } from '../errors.js';
import { Database } from '../index.js';
import { parseScript } from '../sql/parser.js';
import { FORMATS, render } from './render.js';

const USAGE = `usage: csvql [options] "<query>"
       csvql [options] -f <file>
       csvql [options] < <file>

Runs SQL queries on CSV files. A table is a file in the data directory, named
without its extension, or a path in quotes:

  csvql -d data "SELECT city, COUNT(*) FROM people GROUP BY city"
  csvql "SELECT * FROM 'downloads/report.csv' LIMIT 10"

options:
  -d, --dir <path>        where table names are looked up (default: .)
  -f, --file <path>       run the statements in a file
  -o, --format <format>   table, csv or json (default: table)
      --delimiter <char>  field delimiter of the files (default: detected)
      --no-optimize       run each query as written, with the optimiser off
  -h, --help              show this help
  -v, --version           show the version
`;

const OPTIONS = {
  dir: { type: 'string', short: 'd', default: '.' },
  file: { type: 'string', short: 'f' },
  format: { type: 'string', short: 'o', default: 'table' },
  delimiter: { type: 'string' },
  'no-optimize': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

const BUFFER_SIZE = 64 * 1024;
const OK = 0;
const FAILED = 1;
const MISUSED = 2;

//writes pieces of output in large blocks, and waits when the reader of the
//pipe falls behind, so that a slow reader does not make memory grow
async function writeAll(stream, pieces) {
  let buffer = '';
  const flush = async () => {
    if (buffer !== '' && !stream.write(buffer)) await once(stream, 'drain');
    buffer = '';
  };
  for await (const piece of pieces) {
    buffer += piece;
    if (buffer.length >= BUFFER_SIZE) await flush();
  }
  await flush();
}

//runs every statement of a script and writes each result. stops at the first
//one that fails, and says whether they all succeeded.
export async function runScript(db, script, format, { stdout, stderr }) {
  let statements;
  try {
    statements = parseScript(script);
  } catch (error) {
    stderr.write(`${describeError(error, script)}\n`);
    return false;
  }

  for (const [index, { text: sql }] of statements.entries()) {
    try {
      const result = await db.stream(sql);
      if (index > 0 && format === 'table') stdout.write('\n');
      //a plan is already laid out, and a table around it would only get in the way
      const output =
        result.isPlan && format === 'table' ? plainLines(result.rows) : render(format, result);
      await writeAll(stdout, output);
    } catch (error) {
      stderr.write(`${describeError(error, sql)}\n`);
      return false;
    }
  }
  return true;
}

async function* plainLines(rows) {
  for await (const [line] of rows) yield `${line}\n`;
}

async function readVersion() {
  const manifest = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
  return JSON.parse(manifest).version;
}

//runs the command line with the given arguments and returns its exit status
export async function main(args, { stdin, stdout, stderr }) {
  const misuse = (message) => {
    stderr.write(`csvql: ${message}\ntry "csvql --help"\n`);
    return MISUSED;
  };

  let parsed;
  try {
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    return misuse(error.message);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    stdout.write(USAGE);
    return OK;
  }
  if (values.version) {
    stdout.write(`${await readVersion()}\n`);
    return OK;
  }
  if (!FORMATS.includes(values.format)) {
    return misuse(`unknown format "${values.format}"; use ${FORMATS.join(', ')}`);
  }
  if (positionals.length > 1) return misuse('expected one query; put it in quotes');
  if (positionals.length === 1 && values.file !== undefined) {
    return misuse('give a query or a file of queries, not both');
  }

  let script;
  if (values.file !== undefined) {
    try {
      script = await readFile(values.file, 'utf8');
    } catch {
      stderr.write(`error: cannot read ${values.file}\n`);
      return FAILED;
    }
  } else {
    script = positionals.length === 1 ? positionals[0] : await text(stdin);
  }
  if (script.trim() === '') return misuse('no query given');

  const db = new Database({
    dir: values.dir,
    //a tab is awkward to type in a shell, so the two characters \t stand for one
    delimiter: values.delimiter === '\\t' ? '\t' : values.delimiter,
    optimizer: values['no-optimize'] ? false : {},
  });
  return (await runScript(db, script, values.format, { stdout, stderr })) ? OK : FAILED;
}
