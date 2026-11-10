//reads a csv file from disk as batches of records. the file is decoded and
//parsed one chunk at a time, so memory use does not grow with the file, and a
//caller that stops early stops the reading with it.

import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { CsvParser } from './parser.js';

export const DEFAULT_CHUNK_SIZE = 256 * 1024;

const BYTE_ORDER_MARK = 0xfeff;

//yields arrays of records, each record an array of fields. the header is the
//first record of the first batch. progress, if given, has its bytesRead count
//kept up to date as the file is consumed.
export async function* readRecords(path, options = {}) {
  const { delimiter = ',', keep = null, chunkSize = DEFAULT_CHUNK_SIZE, progress = null } = options;
  const parser = new CsvParser({ delimiter, keep });
  //a chunk can end part way through a multi-byte character. the decoder holds
  //the loose bytes back and joins them to the start of the next chunk.
  const decoder = new StringDecoder('utf8');
  let started = false;

  for await (const chunk of createReadStream(path, { highWaterMark: chunkSize })) {
    if (progress !== null) progress.bytesRead += chunk.length;
    let text = decoder.write(chunk);
    if (!started && text.length > 0) {
      started = true;
      if (text.charCodeAt(0) === BYTE_ORDER_MARK) text = text.slice(1);
    }
    const records = parser.write(text);
    if (records.length > 0) yield records;
  }

  const records = parser.end(decoder.end());
  if (records.length > 0) yield records;
}
