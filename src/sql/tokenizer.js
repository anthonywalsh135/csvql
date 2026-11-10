//the tokeniser. turns sql text into a flat list of tokens. every token keeps
//its start and end offset in the source, which is what lets a later stage
//point at the exact character an error came from.

import { SqlSyntaxError } from '../errors.js';

const KEYWORDS = new Set([
  'SELECT',
  'DISTINCT',
  'FROM',
  'WHERE',
  'GROUP',
  'BY',
  'HAVING',
  'ORDER',
  'ASC',
  'DESC',
  'LIMIT',
  'OFFSET',
  'AS',
  'JOIN',
  'INNER',
  'LEFT',
  'OUTER',
  'CROSS',
  'ON',
  'AND',
  'OR',
  'NOT',
  'IN',
  'BETWEEN',
  'LIKE',
  'IS',
  'NULL',
  'TRUE',
  'FALSE',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'CAST',
  'EXPLAIN',
  'ANALYZE',
  //not supported, but reserved so that they get a clear error instead of being
  //read as a table alias
  'RIGHT',
  'FULL',
  'NATURAL',
  'USING',
  'UNION',
  'EXCEPT',
  'INTERSECT',
]);

//longest first, so that "<=" is not read as "<" followed by "="
const OPERATORS = ['<>', '!=', '<=', '>=', '||', ...'=<>+-*/%(),.;'];

const WHITESPACE = /\s+/y;
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const WORD = /[\p{L}_][\p{L}\p{N}_$]*/uy;
const DIGIT = /\d/;

function match(pattern, sql, pos) {
  pattern.lastIndex = pos;
  const found = pattern.exec(sql);
  return found === null ? null : found[0];
}

//reads text wrapped in a quote character, where the quote itself is written
//by doubling it. returns the unescaped text and the offset just past the end.
function readQuoted(sql, start, quote, what) {
  let text = '';
  let pos = start + 1;
  for (;;) {
    const close = sql.indexOf(quote, pos);
    if (close === -1) throw new SqlSyntaxError(`${what} is never closed`, start);
    text += sql.slice(pos, close);
    if (sql[close + 1] !== quote) return [text, close + 1];
    text += quote;
    pos = close + 2;
  }
}

//splits sql text into tokens. the list always ends with an "end" token, so the
//parser can look ahead without checking for the end of the list.
export function tokenize(sql) {
  const tokens = [];
  let pos = 0;

  const push = (type, value, end, extra) => {
    tokens.push({ type, value, start: pos, end, ...extra });
    pos = end;
  };

  while (pos < sql.length) {
    const ch = sql[pos];

    const space = match(WHITESPACE, sql, pos);
    if (space !== null) {
      pos += space.length;
    } else if (sql.startsWith('--', pos)) {
      const lineEnd = sql.indexOf('\n', pos);
      pos = lineEnd === -1 ? sql.length : lineEnd;
    } else if (sql.startsWith('/*', pos)) {
      const close = sql.indexOf('*/', pos + 2);
      if (close === -1) throw new SqlSyntaxError('comment is never closed', pos);
      pos = close + 2;
    } else if (ch === "'") {
      const [text, end] = readQuoted(sql, pos, "'", 'string');
      push('string', text, end);
    } else if (ch === '"' || ch === '[') {
      //a quoted name is never a keyword, which is how a column called "order"
      //or one with a space in it can be written
      const [text, end] = readQuoted(sql, pos, ch === '[' ? ']' : '"', 'quoted name');
      if (text === '') throw new SqlSyntaxError('a quoted name cannot be empty', pos);
      push('identifier', text, end, { quoted: true });
    } else if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(sql[pos + 1] ?? ''))) {
      const text = match(NUMBER, sql, pos);
      if (match(WORD, sql, pos + text.length) !== null) {
        throw new SqlSyntaxError('a number cannot be followed directly by a letter', pos);
      }
      push('number', Number(text), pos + text.length);
    } else {
      const word = match(WORD, sql, pos);
      const operator = OPERATORS.find((op) => sql.startsWith(op, pos));
      if (word !== null) {
        const upper = word.toUpperCase();
        if (KEYWORDS.has(upper)) push('keyword', upper, pos + word.length);
        else push('identifier', word, pos + word.length);
      } else if (operator !== undefined) {
        push('operator', operator, pos + operator.length);
      } else {
        throw new SqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`, pos);
      }
    }
  }

  push('end', null, pos);
  return tokens;
}
