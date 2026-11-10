//works out what a csv file holds without being told: its delimiter, its column
//names, a type for each column and roughly how many rows there are. all of it
//comes from the first rows of the file, so opening a large file costs no more
//than opening a small one.

import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { CsvError } from '../errors.js';
import { DEFAULT_CHUNK_SIZE, readRecords } from './reader.js';
import { inferType } from './types.js';

const DEFAULT_SAMPLE_ROWS = 1000;
const SAMPLE_CHUNK_SIZE = 64 * 1024;
const DELIMITERS = [',', '\t', ';', '|'];

//picks the delimiter that splits the header line into the most fields. one
//inside quotes is part of a column name and does not count.
export function detectDelimiter(headerLine) {
  let best = ',';
  let bestCount = 0;
  for (const candidate of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (const ch of headerLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === candidate && !quoted) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

async function readFirstLine(path) {
  const handle = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(SAMPLE_CHUNK_SIZE), 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    const lineEnd = text.search(/[\r\n]/);
    return lineEnd === -1 ? text : text.slice(0, lineEnd);
  } finally {
    await handle.close();
  }
}

//every column needs a name that can be told apart from the others, so blanks
//are filled in and repeats are numbered
function columnNames(header) {
  const taken = new Set();
  return header.map((field, index) => {
    const base = (field ?? '').trim() || `column_${index + 1}`;
    let name = base;
    for (let copy = 2; taken.has(name.toLowerCase()); copy++) name = `${base}_${copy}`;
    taken.add(name.toLowerCase());
    return name;
  });
}

//reads the start of a file and describes it as
//{ columns: [{ name, type }], delimiter, estimatedRows }
export async function inferSchema(path, options = {}) {
  const { sampleRows = DEFAULT_SAMPLE_ROWS, chunkSize = DEFAULT_CHUNK_SIZE } = options;
  const delimiter = options.delimiter ?? detectDelimiter(await readFirstLine(path));
  const { size } = await stat(path);

  const progress = { bytesRead: 0 };
  const records = [];
  const reading = { delimiter, chunkSize: Math.min(chunkSize, SAMPLE_CHUNK_SIZE), progress };
  for await (const batch of readRecords(path, reading)) {
    for (const record of batch) records.push(record);
    if (records.length > sampleRows) break;
  }
  if (records.length === 0) {
    throw new CsvError(`${basename(path)} is empty, so there is no header to name its columns`);
  }

  const [header, ...rows] = records;
  const columns = columnNames(header).map((name, index) => {
    //a row can be shorter than the header, which leaves a gap rather than a null
    const values = rows.map((row) => row[index] ?? null).filter((value) => value !== null);
    return { name, type: inferType(values) };
  });

  //the rows seen so far, scaled up from the bytes read to the size of the file.
  //when the sample reached the end of the file this is the exact count.
  const estimatedRows = Math.max(0, Math.round((records.length * size) / progress.bytesRead) - 1);
  return { columns, delimiter, estimatedRows };
}
