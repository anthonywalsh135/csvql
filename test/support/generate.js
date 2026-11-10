//random tables and random queries over them, for checking the engine against
//sqlite. the queries stay inside the part of sql where the two are meant to
//agree: every comparison is between values of one type, there is no division
//(sqlite divides integers, this engine does not), and real numbers are
//multiples of a quarter, so sums are exact in whatever order they are added.

const WORDS = [
  'apple',
  'Apple',
  'banana',
  'cherry',
  'date',
  'a,b',
  'say "hi"',
  "o'neil",
  'x y',
  '',
];
const PATTERNS = ['a%', '%e', '%an%', '_pple', '%', 'APPLE', '%,%', 'b_n%', ''];
const COMPARISONS = ['=', '<>', '<', '<=', '>', '>='];

export const SCHEMA = {
  t1: { id: 'int', a: 'int', b: 'real', c: 'text', d: 'bool', g: 'int' },
  t2: { id: 'int', t1_id: 'int', x: 'int', y: 'text' },
  t3: { k: 'int', label: 'text' },
};

const quote = (text) => `'${text.replaceAll("'", "''")}'`;

//rows for each table of the schema. about one value in six is null.
export function randomTables(random, sizes) {
  const maybe = (value) => (random.chance(0.16) ? null : value());
  const rows = (count, make) => Array.from({ length: count }, (_, index) => make(index + 1));
  return {
    t1: rows(sizes.t1, (id) => [
      id,
      maybe(() => random.int(0, 9)),
      maybe(() => random.int(-20, 80) / 4),
      maybe(() => random.pick(WORDS)),
      maybe(() => random.chance(0.5)),
      random.int(0, 3),
    ]),
    t2: rows(sizes.t2, (id) => [
      id,
      maybe(() => random.int(0, sizes.t1 + 2)),
      maybe(() => random.int(-5, 15)),
      maybe(() => random.pick(WORDS)),
    ]),
    t3: rows(sizes.t3, () => [maybe(() => random.int(0, 5)), random.pick(WORDS)]),
  };
}

const columnsOf = (table, alias = table) =>
  Object.entries(SCHEMA[table]).map(([name, type]) => ({ ref: `${alias}.${name}`, type }));

const SHAPES = [
  () => ({ from: 't1', columns: columnsOf('t1') }),
  () => ({ from: 't1', columns: columnsOf('t1') }),
  () => ({ from: 't2', columns: columnsOf('t2') }),
  (g) => {
    const columns = [...columnsOf('t1'), ...columnsOf('t2')];
    const extra = g.random.chance(0.4) ? ` AND ${g.withColumns(columns).bool(1)}` : '';
    return { from: `t1 JOIN t2 ON t2.t1_id = t1.id${extra}`, columns };
  },
  (g) => {
    const columns = [...columnsOf('t1'), ...columnsOf('t2')];
    const scope = g.random.chance(0.5) ? columnsOf('t2') : columns;
    const extra = g.random.chance(0.5) ? ` AND ${g.withColumns(scope).bool(1)}` : '';
    return { from: `t1 LEFT JOIN t2 ON t2.t1_id = t1.id${extra}`, columns };
  },
  (g) => {
    const where = g.random.chance(0.6) ? 't2.t1_id = t1.id' : null;
    return { from: 't1, t2', columns: [...columnsOf('t1'), ...columnsOf('t2')], where };
  },
  () => ({
    from: 't1 JOIN t2 ON t2.t1_id = t1.id JOIN t3 ON t3.k = t1.g',
    columns: [...columnsOf('t1'), ...columnsOf('t2'), ...columnsOf('t3')],
  }),
  () => ({
    from: 't2 LEFT JOIN t3 ON t3.k = t2.x',
    columns: [...columnsOf('t2'), ...columnsOf('t3')],
  }),
  () => ({ from: 't1 JOIN t3 ON t3.k < t1.a', columns: [...columnsOf('t1'), ...columnsOf('t3')] }),
  () => ({
    from: 't1 AS l JOIN t1 AS r ON l.g = r.g AND l.id < r.id',
    columns: [...columnsOf('t1', 'l'), ...columnsOf('t1', 'r')],
  }),
];

class Generator {
  constructor(random, columns = []) {
    this.random = random;
    this.columns = columns;
  }

  withColumns(columns) {
    return new Generator(this.random, columns);
  }

  column(...types) {
    const candidates = this.columns.filter((column) => types.includes(column.type));
    return candidates.length === 0 ? null : this.random.pick(candidates).ref;
  }

  oneOf(...makers) {
    return this.random.pick(makers)();
  }

  num(depth) {
    const leaf = () =>
      (this.random.chance(0.7) && this.column('int', 'real')) || String(this.random.int(-3, 12));
    if (depth === 0) return leaf();
    return this.oneOf(
      leaf,
      leaf,
      () => `(${this.num(depth - 1)} + ${this.num(depth - 1)})`,
      () => `(${this.num(depth - 1)} - ${this.num(depth - 1)})`,
      () => `(${leaf()} * ${leaf()})`,
      () => `ABS(${this.num(depth - 1)})`,
      () => `COALESCE(${this.num(depth - 1)}, ${this.num(depth - 1)})`,
      () => `CASE WHEN ${this.bool(0)} THEN ${this.num(depth - 1)} ELSE ${leaf()} END`,
      () => `LENGTH(${this.text(depth - 1)})`,
    );
  }

  text(depth) {
    const leaf = () =>
      (this.random.chance(0.7) && this.column('text')) || quote(this.random.pick(WORDS));
    if (depth === 0) return leaf();
    return this.oneOf(
      leaf,
      leaf,
      () => `UPPER(${this.text(depth - 1)})`,
      () => `LOWER(${this.text(depth - 1)})`,
      () => `(${this.text(depth - 1)} || ${this.text(depth - 1)})`,
      () => `COALESCE(${this.text(depth - 1)}, ${leaf()})`,
      () => `SUBSTR(${this.text(depth - 1)}, ${this.random.int(1, 3)}, ${this.random.int(0, 3)})`,
      () => `CASE WHEN ${this.bool(0)} THEN ${leaf()} ELSE ${this.text(depth - 1)} END`,
    );
  }

  list(make) {
    const items = Array.from({ length: this.random.int(1, 4) }, make);
    if (this.random.chance(0.2)) items.push('NULL');
    return items.join(', ');
  }

  bool(depth) {
    const not = () => (this.random.chance(0.3) ? 'NOT ' : '');
    const comparison = () => this.random.pick(COMPARISONS);
    const simple = () =>
      this.oneOf(
        () => `${this.num(1)} ${comparison()} ${this.num(1)}`,
        () => `${this.num(1)} ${comparison()} ${this.num(0)}`,
        () => `${this.text(1)} ${comparison()} ${this.text(0)}`,
        () => this.column('bool') ?? `${this.num(0)} > 2`,
        () =>
          `${this.oneOf(
            () => this.num(1),
            () => this.text(1),
          )} IS ${not()}NULL`,
        () =>
          `${this.num(1)} ${not()}IN (${this.list(() => (this.random.chance(0.3) ? this.num(0) : String(this.random.int(-2, 10))))})`,
        () => `${this.text(0)} ${not()}IN (${this.list(() => this.text(0))})`,
        () => `${this.num(1)} ${not()}BETWEEN ${this.num(0)} AND ${this.num(0)}`,
        () => `${this.text(1)} ${not()}LIKE ${quote(this.random.pick(PATTERNS))}`,
      );
    if (depth === 0) return `(${simple()})`;
    return this.oneOf(
      () => `(${simple()})`,
      () => `(${this.bool(depth - 1)} AND ${this.bool(depth - 1)})`,
      () => `(${this.bool(depth - 1)} OR ${this.bool(depth - 1)})`,
      () => `(NOT ${this.bool(depth - 1)})`,
    );
  }

  any(depth) {
    return this.oneOf(
      () => this.num(depth),
      () => this.text(depth),
      () => this.bool(depth),
    );
  }

  aggregate() {
    return this.oneOf(
      () => 'COUNT(*)',
      () => `COUNT(${this.any(1)})`,
      () =>
        `COUNT(DISTINCT ${this.oneOf(
          () => this.num(1),
          () => this.text(1),
        )})`,
      () => `SUM(${this.num(1)})`,
      () => `AVG(${this.num(1)})`,
      () =>
        `MIN(${this.oneOf(
          () => this.num(1),
          () => this.text(1),
        )})`,
      () =>
        `MAX(${this.oneOf(
          () => this.num(1),
          () => this.text(1),
        )})`,
    );
  }
}

//builds one query. ordered says whether the query fixes the order of its rows
//completely, in which case the two engines must agree on the order as well.
export function randomQuery(random) {
  const shape = random.pick(SHAPES)(new Generator(random));
  const g = new Generator(random, shape.columns);
  const many = (min, max, make) => Array.from({ length: random.int(min, max) }, make);

  const conditions = [];
  if (shape.where) conditions.push(shape.where);
  if (random.chance(0.6)) conditions.push(g.bool(2));
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

  let items;
  let tail = '';
  let distinct = '';
  if (random.chance(0.45)) {
    const keys = many(0, 2, () => g.any(1));
    items = [...keys, ...many(1, 3, () => g.aggregate())];
    if (keys.length > 0) tail += ` GROUP BY ${keys.map((_, index) => index + 1).join(', ')}`;
    if (random.chance(0.3)) {
      tail += ` HAVING ${g.aggregate()} ${random.pick(COMPARISONS)} ${random.int(0, 4)}`;
    }
  } else {
    items = many(1, 4, () => g.any(2));
    if (random.chance(0.2)) distinct = 'DISTINCT ';
  }

  let ordered = false;
  if (random.chance(0.5)) {
    //sorting on every output column leaves nothing for the engines to differ on
    const keys = items.map((_, index) => `${index + 1}${random.chance(0.4) ? ' DESC' : ''}`);
    tail += ` ORDER BY ${keys.join(', ')}`;
    ordered = true;
    if (random.chance(0.7)) {
      tail += ` LIMIT ${random.int(0, 6)}`;
      if (random.chance(0.4)) tail += ` OFFSET ${random.int(0, 3)}`;
    }
  }

  const list = items.map((item, index) => `${item} AS c${index + 1}`).join(', ');
  return { sql: `SELECT ${distinct}${list} FROM ${shape.from}${where}${tail}`, ordered };
}
