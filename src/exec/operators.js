//the operators that work a batch at a time and hold nothing back: reading a
//file, filtering, computing the select list, removing duplicates and limiting.
//each is an async generator over batches of rows.

import { readRecords } from '../csv/reader.js';
import { converterFor } from '../csv/types.js';
import { encodeKey } from './values.js';

//reads the columns a scan node asks for and converts each field to the type
//of its column. columns nobody asked for are never copied out of the file.
export async function* scan({ table, columns }, chunkSize) {
  const keep = table.columns.map(() => false);
  for (const column of columns) keep[column.index] = true;

  //text is already the value, so only the other types need any work
  const conversions = [];
  columns.forEach((column, slot) => {
    const convert = converterFor(column.type);
    if (convert !== null) conversions.push([slot, convert]);
  });

  let atHeader = true;
  const reading = { delimiter: table.delimiter, keep, chunkSize };
  for await (const records of readRecords(table.path, reading)) {
    if (atHeader) {
      records.shift();
      atHeader = false;
    }
    for (const record of records) {
      for (const [slot, convert] of conversions) {
        if (record[slot] !== null) record[slot] = convert(record[slot]);
      }
    }
    if (records.length > 0) yield records;
  }
}

export async function* filter(input, predicate) {
  for await (const batch of input) {
    const kept = batch.filter(predicate);
    if (kept.length > 0) yield kept;
  }
}

export async function* project(input, exprs) {
  for await (const batch of input) {
    yield batch.map((row) => exprs.map((expr) => expr(row)));
  }
}

//keeps the first of each set of identical rows, in the order they arrive
export async function* distinct(input) {
  const seen = new Set();
  for await (const batch of input) {
    const fresh = batch.filter((row) => {
      const key = encodeKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length > 0) yield fresh;
  }
}

//returning from the loop closes the input, which closes whatever is beneath
//it, so a LIMIT stops the file being read as soon as it has enough rows
export async function* limit(input, count, offset) {
  if (count === 0) return;
  let toSkip = offset;
  let remaining = count;
  for await (const batch of input) {
    const skipped = Math.min(toSkip, batch.length);
    toSkip -= skipped;
    const rows = batch.slice(skipped, skipped + remaining);
    remaining -= rows.length;
    if (rows.length > 0) yield rows;
    if (remaining === 0) return;
  }
}
