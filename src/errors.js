//the errors the engine raises. there is one kind per stage of the pipeline, and
//most carry the offset in the sql text that caused them, so that the command
//line can print the query with a caret under the exact character.

export class CsvqlError extends Error {
  constructor(message, position = null) {
    super(message);
    this.name = new.target.name;
    this.position = position;
  }
}

//the text is not valid sql
export class SqlSyntaxError extends CsvqlError {}

//the query parses, but names something that does not exist or breaks a rule
export class BindError extends CsvqlError {}

//a value met an operation it cannot be used with while the query was running
export class ExecutionError extends CsvqlError {}

//a file could not be read as csv
export class CsvError extends CsvqlError {}

//renders an error for a terminal. when the error knows where in the query it
//happened, the offending line is printed with a caret under that position.
export function describeError(error, sql = '') {
  const summary = `error: ${error.message}`;
  if (!(error instanceof CsvqlError) || error.position === null) return summary;
  if (error.position > sql.length) return summary;

  const lineStart = sql.lastIndexOf('\n', error.position - 1) + 1;
  const nextBreak = sql.indexOf('\n', error.position);
  const lineEnd = nextBreak === -1 ? sql.length : nextBreak;
  //a tab would push the caret out of line with the character above it
  const line = sql.slice(lineStart, lineEnd).replace(/\t/g, ' ').replace(/\r$/, '');
  const caret = ' '.repeat(error.position - lineStart) + '^';
  return `${summary}\n  ${line}\n  ${caret}`;
}
