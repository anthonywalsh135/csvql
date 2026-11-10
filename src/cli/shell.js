//the interactive shell. a statement can run over several lines and is sent
//when a line ends with a semicolon. a line that starts with a dot is a command
//for the shell itself.

import { createInterface } from 'node:readline';

import { describeError } from '../errors.js';
import { runScript } from './main.js';

const PROMPT = 'csvql> ';
const CONTINUED = '   ...> ';

const HELP = `Type a query and end it with a semicolon. It can run over several lines.

  .tables          list the tables in the data directory
  .schema <table>  show the columns of a table and their types
  .help            show this
  .quit            leave

Put EXPLAIN in front of a query to see its plan, or EXPLAIN ANALYZE to run it
and see how many rows went through each step.
`;

const thousands = (count) => count.toLocaleString('en-GB');

async function listTables(db) {
  const tables = await db.tables();
  if (tables.length === 0) return 'there are no csv files in the data directory\n';
  const width = Math.max(...tables.map((table) => table.name.length));
  const lines = [];
  for (const { name } of tables) {
    const { columns, estimatedRows } = await db.schema(name);
    const size = `~${thousands(estimatedRows)} rows, ${columns.length} columns`;
    lines.push(`${name.padEnd(width)}  ${size}`);
  }
  return `${lines.join('\n')}\n`;
}

async function describeTable(db, name) {
  if (name === undefined) return 'usage: .schema <table>\n';
  const { file, columns, estimatedRows } = await db.schema(name);
  const width = Math.max(...columns.map((column) => column.name.length));
  const lines = columns.map((column) => `  ${column.name.padEnd(width)}  ${column.type}`);
  return `${file}, ~${thousands(estimatedRows)} rows\n${lines.join('\n')}\n`;
}

//runs one dot command and returns what to print, or null to leave the shell
async function runCommand(db, line) {
  const [command, argument] = line.split(/\s+/);
  switch (command) {
    case '.quit':
    case '.exit':
      return null;
    case '.help':
      return HELP;
    case '.tables':
      return listTables(db);
    case '.schema':
      return describeTable(db, argument);
    default:
      return `unknown command ${command}; try .help\n`;
  }
}

//reads statements from input until it closes or .quit is typed, writing
//results to output. returns the exit status of the shell.
export async function startShell({ db, input, output }) {
  const lines = createInterface({ input, output, prompt: PROMPT });
  let statement = '';

  //when the input is a file or a pipe it can close while lines read from it
  //are still waiting to be run, and a closed interface cannot be prompted
  let open = true;
  lines.on('close', () => {
    open = false;
  });
  const prompt = () => {
    if (!open) return;
    lines.setPrompt(statement === '' ? PROMPT : CONTINUED);
    lines.prompt();
  };

  //ctrl-c abandons a half-typed statement, and leaves when there is none
  lines.on('SIGINT', () => {
    if (statement === '') {
      lines.close();
    } else {
      statement = '';
      output.write('\n');
      prompt();
    }
  });

  output.write('csvql shell. Type .help for help.\n');
  prompt();
  for await (const line of lines) {
    if (statement === '' && line.trim().startsWith('.')) {
      const reply = await runCommand(db, line.trim()).catch((error) => `${describeError(error)}\n`);
      if (reply === null) break;
      output.write(reply);
    } else if (line.trim() !== '' || statement !== '') {
      statement += `${line}\n`;
      if (line.trimEnd().endsWith(';')) {
        const started = performance.now();
        const streams = { stdout: output, stderr: output };
        const succeeded = await runScript(db, statement, 'table', streams);
        if (succeeded) output.write(`${(performance.now() - started).toFixed(1)} ms\n`);
        statement = '';
      }
    }
    prompt();
  }
  lines.close();
  return 0;
}
