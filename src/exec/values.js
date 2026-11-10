//what a value is while a query runs, and how two of them compare. a value is
//null, a boolean, a number or a string.
//
//there is a single ordering over all of them, shared by the comparison
//operators, ORDER BY, MIN and MAX: null first, then booleans, then numbers,
//then text, which is the order sqlite uses. comparing across types never
//converts either side, so 10 is less than '9' because every number sorts
//before any text.

import { ExecutionError } from '../errors.js';

function rank(value) {
  if (value === null) return 0;
  if (typeof value === 'boolean') return 1;
  return typeof value === 'number' ? 2 : 3;
}

//negative, zero or positive, the way a sort comparator wants it
export function compareValues(a, b) {
  if (typeof a === typeof b && a !== null && b !== null) {
    if (a < b) return -1;
    return a > b ? 1 : 0;
  }
  return rank(a) - rank(b);
}

//a string that is the same for two lists of values exactly when the lists are
//equal, for use as the key of a hash table. every value is tagged with its
//type, and text carries its length, so that different lists cannot run
//together into the same key.
export function encodeKey(values) {
  let key = '';
  for (const value of values) {
    if (value === null) key += 'n;';
    else if (typeof value === 'number') key += `d${value};`;
    else if (typeof value === 'string') key += `s${value.length}:${value}`;
    else key += value ? 't;' : 'f;';
  }
  return key;
}

//how a value reads as a condition. null is "unknown" and stays null, and a
//number is true unless it is zero. text is never a condition.
export function truth(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  throw new ExecutionError(`expected a condition but got ${describeValue(value)}`);
}

export function toText(value) {
  return typeof value === 'string' ? value : String(value);
}

//a value as it should appear in an error message
export function describeValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const shown = value.length > 30 ? `${value.slice(0, 30)}...` : value;
    return `the text '${shown}'`;
  }
  return `the ${typeof value} ${value}`;
}
