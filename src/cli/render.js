//turns a result into text: an aligned table for reading, or csv or json for
//handing to another program

import { formatRecord } from '../csv/writer.js';

export const FORMATS = ['table', 'csv', 'json'];

//a line break inside a value would break the table apart, so it is shown as
//the two characters \n instead
function cellText(value) {
  if (value === null) return 'NULL';
  return String(value)
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

//counted in whole characters, so that an accented letter takes one column
const widthOf = (text) => Array.from(text).length;

//lays a result out the way psql does: a heading, a rule, the rows and a count.
//numbers are set to the right so that their digits line up.
export function formatTable(columns, rows) {
  const cells = rows.map((row) => row.map(cellText));
  const widths = columns.map(widthOf);
  const numeric = columns.map(() => rows.length > 0);
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      widths[c] = Math.max(widths[c], widthOf(cells[r][c]));
      if (value !== null && typeof value !== 'number') numeric[c] = false;
    });
  });

  const line = (texts, alignRight) => {
    const padded = texts.map((text, c) => {
      const gap = ' '.repeat(widths[c] - widthOf(text));
      return alignRight && numeric[c] ? gap + text : text + gap;
    });
    return ` ${padded.join(' | ')}`.trimEnd();
  };
  const rule = widths.map((width) => '-'.repeat(width + 2)).join('+');
  const count = `(${rows.length} ${rows.length === 1 ? 'row' : 'rows'})`;
  return [line(columns, false), rule, ...cells.map((row) => line(row, true)), count].join('\n');
}

//json objects cannot have two keys the same, so a repeated heading is numbered
function uniqueNames(columns) {
  const taken = new Set();
  return columns.map((column) => {
    let name = column;
    for (let copy = 2; taken.has(name); copy++) name = `${column}_${copy}`;
    taken.add(name);
    return name;
  });
}

//yields the output in pieces. csv and json are produced as the rows arrive, so
//a large result can be piped to a file without ever being held in memory. a
//table has to wait for the last row, since every row has a say in the widths.
export async function* render(format, { columns, rows }) {
  if (format === 'table') {
    yield `${formatTable(columns, await Array.fromAsync(rows))}\n`;
  } else if (format === 'csv') {
    yield `${formatRecord(columns)}\n`;
    for await (const row of rows) yield `${formatRecord(row)}\n`;
  } else {
    const keys = uniqueNames(columns);
    let opening = '[\n  ';
    for await (const row of rows) {
      yield opening + JSON.stringify(Object.fromEntries(keys.map((key, i) => [key, row[i]])));
      opening = ',\n  ';
    }
    yield opening === '[\n  ' ? '[]\n' : '\n]\n';
  }
}
