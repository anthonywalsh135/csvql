//the parser. recursive descent over the token list, producing a plain object
//tree. clauses are parsed by one method each, and expressions by one method per
//precedence level, lowest first, so that the shape of the code is the grammar:
//
//  OR < AND < NOT < comparison < + - < * / % < || < unary minus < primary
//
//nothing here knows what a table or a column is. names are checked later by
//the binder, once the files have been looked at.

import { SqlSyntaxError } from '../errors.js';
import { tokenize } from './tokenizer.js';

const COMPARISONS = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);

const CAST_TYPES = new Map([
  ['INTEGER', 'integer'],
  ['INT', 'integer'],
  ['REAL', 'real'],
  ['FLOAT', 'real'],
  ['DOUBLE', 'real'],
  ['TEXT', 'text'],
  ['VARCHAR', 'text'],
  ['STRING', 'text'],
  ['BOOLEAN', 'boolean'],
  ['BOOL', 'boolean'],
]);

const binary = (op, left, right) => ({ type: 'binary', op, left, right });
const literal = (value) => ({ type: 'literal', value });

class Parser {
  constructor(sql) {
    this.sql = sql;
    this.tokens = tokenize(sql);
    this.index = 0;
  }

  get current() {
    return this.tokens[this.index];
  }

  get atEnd() {
    return this.current.type === 'end';
  }

  //the end token is never stepped over, so looking ahead is always safe
  peek(distance) {
    return this.tokens[Math.min(this.index + distance, this.tokens.length - 1)];
  }

  advance() {
    const token = this.current;
    if (!this.atEnd) this.index += 1;
    return token;
  }

  isKeyword(...words) {
    return this.current.type === 'keyword' && words.includes(this.current.value);
  }

  isOperator(op, token = this.current) {
    return token.type === 'operator' && token.value === op;
  }

  acceptKeyword(word) {
    if (!this.isKeyword(word)) return false;
    this.advance();
    return true;
  }

  acceptOperator(op) {
    if (!this.isOperator(op)) return false;
    this.advance();
    return true;
  }

  expectKeyword(word) {
    if (!this.acceptKeyword(word)) throw this.unexpected(word);
  }

  expectOperator(op) {
    if (!this.acceptOperator(op)) throw this.unexpected(`"${op}"`);
  }

  expectIdentifier(what) {
    if (this.current.type !== 'identifier') throw this.unexpected(what);
    return this.advance();
  }

  unexpected(expected) {
    const token = this.current;
    const found = this.atEnd
      ? 'the end of the query'
      : `"${this.sql.slice(token.start, token.end)}"`;
    return new SqlSyntaxError(`expected ${expected} but found ${found}`, token.start);
  }

  parseList(parseItem) {
    const items = [parseItem()];
    while (this.acceptOperator(',')) items.push(parseItem());
    return items;
  }

  parseStatement() {
    const start = this.current.start;
    let explain = null;
    if (this.acceptKeyword('EXPLAIN')) explain = this.acceptKeyword('ANALYZE') ? 'analyze' : 'plan';
    const select = this.parseSelect();
    return { explain, select, start, text: this.sql.slice(start, this.peek(-1).end) };
  }

  parseSelect() {
    this.expectKeyword('SELECT');
    const distinct = this.acceptKeyword('DISTINCT');
    const columns = this.parseList(() => this.parseSelectItem());

    let from = null;
    const joins = [];
    if (this.acceptKeyword('FROM')) {
      from = this.parseTable();
      for (let join = this.parseJoin(); join !== null; join = this.parseJoin()) joins.push(join);
    }

    const where = this.acceptKeyword('WHERE') ? this.parseExpression() : null;

    let groupBy = [];
    if (this.acceptKeyword('GROUP')) {
      this.expectKeyword('BY');
      groupBy = this.parseList(() => this.parseExpression());
    }

    const having = this.acceptKeyword('HAVING') ? this.parseExpression() : null;

    let orderBy = [];
    if (this.acceptKeyword('ORDER')) {
      this.expectKeyword('BY');
      orderBy = this.parseList(() => this.parseOrderItem());
    }

    let limit = null;
    let offset = 0;
    if (this.acceptKeyword('LIMIT')) {
      limit = this.parseCount('LIMIT');
      if (this.acceptKeyword('OFFSET')) offset = this.parseCount('OFFSET');
    }

    return { distinct, columns, from, joins, where, groupBy, having, orderBy, limit, offset };
  }

  parseSelectItem() {
    const start = this.current.start;
    if (this.acceptOperator('*')) return { type: 'star', table: null, pos: start };

    //"t.*" needs two tokens of lookahead to tell it apart from a column "t.c"
    const isTableStar =
      this.current.type === 'identifier' &&
      this.isOperator('.', this.peek(1)) &&
      this.isOperator('*', this.peek(2));
    if (isTableStar) {
      const table = this.advance().value;
      this.index += 2;
      return { type: 'star', table, pos: start };
    }

    const expr = this.parseExpression();
    //kept so that a column without an alias can be headed by what was typed
    const text = this.sql.slice(start, this.peek(-1).end).replace(/\s+/g, ' ');
    return { type: 'expr', expr, alias: this.parseAlias(), text };
  }

  parseAlias() {
    if (this.acceptKeyword('AS')) return this.expectIdentifier('a name after AS').value;
    return this.current.type === 'identifier' ? this.advance().value : null;
  }

  //a table is either a bare name, looked up as a file in the data directory,
  //or a quoted path to the file itself
  parseTable() {
    const token = this.current;
    if (this.isOperator('(')) {
      throw new SqlSyntaxError('subqueries are not supported', token.start);
    }
    if (token.type !== 'identifier' && token.type !== 'string') {
      throw this.unexpected('a table name');
    }
    this.advance();
    const isPath = token.type === 'string';
    return { name: token.value, isPath, alias: this.parseAlias(), pos: token.start };
  }

  parseJoin() {
    const token = this.current;
    if (this.isKeyword('RIGHT', 'FULL', 'NATURAL')) {
      throw new SqlSyntaxError(`${token.value} JOIN is not supported`, token.start);
    }
    if (this.acceptOperator(',')) return { kind: 'cross', table: this.parseTable(), on: null };
    if (this.acceptKeyword('CROSS')) {
      this.expectKeyword('JOIN');
      return { kind: 'cross', table: this.parseTable(), on: null };
    }

    let kind = 'inner';
    if (this.acceptKeyword('LEFT')) {
      this.acceptKeyword('OUTER');
      kind = 'left';
    } else if (!this.acceptKeyword('INNER') && !this.isKeyword('JOIN')) {
      return null;
    }
    this.expectKeyword('JOIN');
    const table = this.parseTable();
    this.expectKeyword('ON');
    return { kind, table, on: this.parseExpression() };
  }

  parseOrderItem() {
    const expr = this.parseExpression();
    const descending = this.acceptKeyword('DESC');
    if (!descending) this.acceptKeyword('ASC');
    return { expr, descending };
  }

  parseCount(clause) {
    const token = this.current;
    if (token.type !== 'number' || !Number.isSafeInteger(token.value)) {
      throw this.unexpected(`a whole number after ${clause}`);
    }
    return this.advance().value;
  }

  parseExpression() {
    return this.parseOr();
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.acceptKeyword('OR')) left = binary('OR', left, this.parseAnd());
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.acceptKeyword('AND')) left = binary('AND', left, this.parseNot());
    return left;
  }

  parseNot() {
    if (this.acceptKeyword('NOT')) return { type: 'unary', op: 'NOT', operand: this.parseNot() };
    return this.parseComparison();
  }

  parseComparison() {
    let left = this.parseAdditive();
    for (;;) {
      const token = this.current;
      if (token.type === 'operator' && COMPARISONS.has(token.value)) {
        this.advance();
        left = binary(token.value === '!=' ? '<>' : token.value, left, this.parseAdditive());
      } else if (this.acceptKeyword('IS')) {
        const negated = this.acceptKeyword('NOT');
        this.expectKeyword('NULL');
        left = { type: 'is_null', negated, operand: left };
      } else {
        const next = this.peek(1);
        const negated =
          this.isKeyword('NOT') &&
          next.type === 'keyword' &&
          ['IN', 'BETWEEN', 'LIKE'].includes(next.value);
        if (negated) this.advance();

        if (this.acceptKeyword('IN')) {
          this.expectOperator('(');
          const list = this.parseList(() => this.parseExpression());
          this.expectOperator(')');
          left = { type: 'in', negated, operand: left, list };
        } else if (this.acceptKeyword('BETWEEN')) {
          //the bounds are parsed above AND in precedence, otherwise the AND
          //that separates them would be taken for a logical one
          const low = this.parseAdditive();
          this.expectKeyword('AND');
          left = { type: 'between', negated, operand: left, low, high: this.parseAdditive() };
        } else if (this.acceptKeyword('LIKE')) {
          left = { type: 'like', negated, operand: left, pattern: this.parseAdditive() };
        } else {
          return left;
        }
      }
    }
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.isOperator('+') || this.isOperator('-')) {
      left = binary(this.advance().value, left, this.parseMultiplicative());
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseConcat();
    while (this.isOperator('*') || this.isOperator('/') || this.isOperator('%')) {
      left = binary(this.advance().value, left, this.parseConcat());
    }
    return left;
  }

  parseConcat() {
    let left = this.parseUnary();
    while (this.acceptOperator('||')) left = binary('||', left, this.parseUnary());
    return left;
  }

  parseUnary() {
    if (this.acceptOperator('+')) return this.parseUnary();
    if (!this.acceptOperator('-')) return this.parsePrimary();
    const operand = this.parseUnary();
    //"-5" is read as the number it looks like rather than a negation of 5
    if (operand.type === 'literal' && typeof operand.value === 'number') {
      return literal(-operand.value);
    }
    return { type: 'unary', op: '-', operand };
  }

  parsePrimary() {
    const token = this.current;
    if (token.type === 'number' || token.type === 'string') return literal(this.advance().value);
    if (token.type === 'identifier') return this.parseName();
    if (this.acceptKeyword('TRUE')) return literal(true);
    if (this.acceptKeyword('FALSE')) return literal(false);
    if (this.acceptKeyword('NULL')) return literal(null);
    if (this.isKeyword('CASE')) return this.parseCase();
    if (this.isKeyword('CAST')) return this.parseCast();
    if (this.isKeyword('SELECT')) {
      throw new SqlSyntaxError('subqueries are not supported', token.start);
    }
    if (this.acceptOperator('(')) {
      const inner = this.parseExpression();
      this.expectOperator(')');
      return inner;
    }
    throw this.unexpected('an expression');
  }

  //a name is a function call if a bracket follows it, a qualified column if a
  //dot does, and a bare column otherwise
  parseName() {
    const first = this.advance();
    if (!first.quoted && this.acceptOperator('(')) return this.parseCall(first);
    if (this.acceptOperator('.')) {
      const name = this.expectIdentifier('a column name').value;
      return { type: 'column', table: first.value, name, pos: first.start };
    }
    return { type: 'column', table: null, name: first.value, pos: first.start };
  }

  parseCall(nameToken) {
    const call = {
      type: 'call',
      name: nameToken.value.toUpperCase(),
      args: [],
      distinct: false,
      star: false,
      pos: nameToken.start,
    };
    if (this.acceptOperator('*')) {
      call.star = true;
    } else if (!this.isOperator(')')) {
      call.distinct = this.acceptKeyword('DISTINCT');
      call.args = this.parseList(() => this.parseExpression());
    }
    this.expectOperator(')');
    return call;
  }

  //both forms of CASE: "CASE WHEN a > 1 THEN ..." and "CASE a WHEN 1 THEN ..."
  parseCase() {
    this.expectKeyword('CASE');
    const operand = this.isKeyword('WHEN') ? null : this.parseExpression();
    const branches = [];
    while (this.acceptKeyword('WHEN')) {
      const when = this.parseExpression();
      this.expectKeyword('THEN');
      branches.push({ when, then: this.parseExpression() });
    }
    if (branches.length === 0) throw this.unexpected('WHEN');
    const otherwise = this.acceptKeyword('ELSE') ? this.parseExpression() : null;
    this.expectKeyword('END');
    return { type: 'case', operand, branches, otherwise };
  }

  parseCast() {
    const pos = this.advance().start;
    this.expectOperator('(');
    const operand = this.parseExpression();
    this.expectKeyword('AS');
    const typeToken = this.expectIdentifier('a type name');
    const to = CAST_TYPES.get(typeToken.value.toUpperCase());
    if (to === undefined) {
      const message = `unknown type "${typeToken.value}"; use INTEGER, REAL, TEXT or BOOLEAN`;
      throw new SqlSyntaxError(message, typeToken.start);
    }
    this.expectOperator(')');
    return { type: 'cast', operand, to, pos };
  }
}

//parses every statement in a script. statements are separated by semicolons,
//and empty ones are skipped.
export function parseScript(sql) {
  const parser = new Parser(sql);
  const statements = [];
  for (;;) {
    if (parser.acceptOperator(';')) continue;
    if (parser.atEnd) return statements;
    statements.push(parser.parseStatement());
    if (!parser.atEnd && !parser.isOperator(';')) throw parser.unexpected('the end of the query');
  }
}

//parses exactly one statement, with or without a semicolon after it
export function parse(sql) {
  const statements = parseScript(sql);
  if (statements.length === 0) throw new SqlSyntaxError('the query is empty', 0);
  if (statements.length > 1) {
    throw new SqlSyntaxError('expected one statement but found more', statements[1].start);
  }
  return statements[0];
}

//parses a lone expression, such as "price * 1.2"
export function parseExpression(sql) {
  const parser = new Parser(sql);
  const expr = parser.parseExpression();
  if (!parser.atEnd) throw parser.unexpected('the end of the expression');
  return expr;
}
