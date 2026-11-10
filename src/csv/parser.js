//the csv parser. text goes in a chunk at a time and whole records come out, so
//a file never has to be in memory at once. a record that is cut in two by the
//end of a chunk is held back until the rest of it arrives.
//
//the format is rfc 4180: a field may be wrapped in double quotes, a quote
//inside a quoted field is written twice, and a quoted field may contain the
//delimiter and line breaks. an empty field with no quotes comes out as null and
//"" comes out as an empty string, which is the only way a csv file has of
//telling the two apart.

import { CsvError } from '../errors.js';

const QUOTE = 34;
const LF = 10;
const CR = 13;

//returned by readRecord when it runs out of text part way through a record
const INCOMPLETE = -1;

//the offset of the delimiter or line break that ends the field at pos
function fieldEnd(input, pos, delimiter) {
  const length = input.length;
  while (pos < length) {
    const code = input.charCodeAt(pos);
    if (code === delimiter || code === LF || code === CR) break;
    pos += 1;
  }
  return pos;
}

export class CsvParser {
  //keep is an optional list of booleans, one per column, naming the fields to
  //return. the others are stepped over without being copied out of the text.
  constructor({ delimiter = ',', keep = null } = {}) {
    this.delimiter = delimiter.charCodeAt(0);
    this.keep = keep;
    this.width = keep === null ? 0 : keep.filter(Boolean).length;
    this.rest = '';
    this.fields = null;
    this.recordCount = 0;
  }

  //takes the next chunk of text and returns the records it completes
  write(text) {
    return this.parse(this.rest + text, false);
  }

  //takes the last of the text and returns every record still outstanding. the
  //final record of a file does not need a line break after it.
  end(text = '') {
    return this.parse(this.rest + text, true);
  }

  parse(input, final) {
    const records = [];
    let pos = 0;
    while (pos < input.length) {
      const next = this.readRecord(input, pos, final);
      if (next === INCOMPLETE) break;
      if (this.fields !== null) records.push(this.fields);
      pos = next;
    }
    this.rest = input.slice(pos);
    return records;
  }

  //reads the record starting at start into this.fields and returns the offset
  //of the record after it. a blank line leaves this.fields as null.
  readRecord(input, start, final) {
    const { delimiter, keep } = this;
    const length = input.length;
    const fields = [];
    let pos = start;
    let column = 0;

    for (;;) {
      const wanted = keep === null || keep[column] === true;
      let value = null;

      if (pos < length && input.charCodeAt(pos) === QUOTE) {
        let text = '';
        let segment = pos + 1;
        for (;;) {
          const quote = input.indexOf('"', segment);
          //a quote at the very end of the text could still be the first half
          //of a doubled quote, so it cannot be judged until more arrives
          if (!final && (quote === -1 || quote === length - 1)) return INCOMPLETE;
          if (quote === -1) {
            const record = this.recordCount + 1;
            throw new CsvError(`record ${record} has a quoted field that is never closed`);
          }
          if (input.charCodeAt(quote + 1) !== QUOTE) {
            if (wanted) text += input.slice(segment, quote);
            pos = quote + 1;
            break;
          }
          if (wanted) text += input.slice(segment, quote + 1);
          segment = quote + 2;
        }
        //text between the closing quote and the delimiter is not valid csv,
        //but dropping it would lose data, so it is kept as part of the field
        const tail = pos;
        pos = fieldEnd(input, pos, delimiter);
        if (wanted) value = pos > tail ? text + input.slice(tail, pos) : text;
      } else {
        const from = pos;
        pos = fieldEnd(input, pos, delimiter);
        if (wanted && pos > from) value = input.slice(from, pos);
      }

      //the field may carry on in the next chunk
      if (pos === length && !final) return INCOMPLETE;
      if (wanted) fields.push(value);
      column += 1;

      if (pos === length) break;
      const code = input.charCodeAt(pos);
      if (code === delimiter) {
        pos += 1;
        continue;
      }

      const blank = column === 1 && pos === start;
      if (code === CR) {
        //whether this is "\r" or "\r\n" depends on a character not yet seen
        if (pos + 1 === length && !final) return INCOMPLETE;
        pos += input.charCodeAt(pos + 1) === LF ? 2 : 1;
      } else {
        pos += 1;
      }
      if (blank) {
        this.fields = null;
        return pos;
      }
      break;
    }

    //a row shorter than the header is padded, so every record has every column
    while (fields.length < this.width) fields.push(null);
    this.fields = fields;
    this.recordCount += 1;
    return pos;
  }
}
