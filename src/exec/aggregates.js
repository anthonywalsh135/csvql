//the aggregate functions. each one is a small object that is fed a value at a
//time and asked for its result at the end, and a grouped query keeps one of
//them per aggregate for every group. null is never passed in: every aggregate
//ignores it, so the caller filters it out once.

import { ExecutionError } from '../errors.js';
import { compareValues, describeValue } from './values.js';

class Count {
  count = 0;

  add() {
    this.count += 1;
  }

  result() {
    return this.count;
  }
}

//adds numbers with neumaier's compensated summation. a plain running total
//loses the low bits of every small number added to a large one, and over a
//million rows the loss shows; here it is tracked in a second variable and put
//back at the end. sums of whole numbers are exact either way.
class Sum {
  total = 0;
  lost = 0;
  count = 0;

  constructor(name) {
    this.name = name;
  }

  add(value) {
    if (typeof value !== 'number') {
      throw new ExecutionError(`${this.name} expects numbers but got ${describeValue(value)}`);
    }
    const next = this.total + value;
    if (Number.isFinite(next)) {
      const larger = Math.abs(this.total) >= Math.abs(value);
      this.lost += larger ? this.total - next + value : value - next + this.total;
    }
    this.total = next;
    this.count += 1;
  }

  result() {
    return this.count === 0 ? null : this.total + this.lost;
  }
}

class Average extends Sum {
  result() {
    return this.count === 0 ? null : super.result() / this.count;
  }
}

//MIN and MAX, which differ only in which way round they compare
class Extreme {
  best = null;

  constructor(direction) {
    this.direction = direction;
  }

  add(value) {
    if (this.best === null || compareValues(value, this.best) * this.direction > 0) {
      this.best = value;
    }
  }

  result() {
    return this.best;
  }
}

//wraps another aggregate so that it is given each different value only once,
//which is all that DISTINCT inside an aggregate means
class Distinct {
  seen = new Set();

  constructor(inner) {
    this.inner = inner;
  }

  add(value) {
    if (this.seen.has(value)) return;
    this.seen.add(value);
    this.inner.add(value);
  }

  result() {
    return this.inner.result();
  }
}

export const AGGREGATES = new Map([
  ['COUNT', () => new Count()],
  ['SUM', () => new Sum('SUM')],
  ['AVG', () => new Average('AVG')],
  ['MIN', () => new Extreme(-1)],
  ['MAX', () => new Extreme(1)],
]);

//a fresh accumulator for one aggregate call in one group
export function createAggregate(name, distinct = false) {
  const aggregate = AGGREGATES.get(name)();
  return distinct ? new Distinct(aggregate) : aggregate;
}
