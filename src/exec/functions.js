//the scalar functions. each entry gives the number of arguments it takes and
//how to apply it. unless an entry sets acceptsNull, a null argument makes the
//result null without the function being called at all.

import { ExecutionError } from '../errors.js';
import { describeValue, toText } from './values.js';

function numberFor(name, value) {
  if (typeof value !== 'number') {
    throw new ExecutionError(`${name} expects a number but got ${describeValue(value)}`);
  }
  return value;
}

//strings are measured and cut in whole characters, so that an emoji or an
//accented letter outside the basic plane counts as one
const characters = (value) => Array.from(toText(value));

//positions count from 1, and a negative start counts back from the end
function substr(value, start, length) {
  const chars = characters(value);
  const begin = Math.trunc(numberFor('SUBSTR', start));
  const from = begin > 0 ? begin - 1 : Math.max(0, chars.length + begin);
  const count = length === undefined ? chars.length : Math.trunc(numberFor('SUBSTR', length));
  return chars.slice(from, from + Math.max(0, count)).join('');
}

//rounds halves away from zero. the decimal point is moved through the text
//form of the number, because multiplying by a power of ten adds binary error:
//1.005 * 100 is 100.49999999999999, which would round 1.005 down to 1.
function round(value, digits = 0) {
  const places = Math.trunc(numberFor('ROUND', digits));
  const magnitude = Math.abs(numberFor('ROUND', value));
  //a whole number has nothing after the point to round
  if (places >= 0 && Number.isInteger(magnitude)) return value;

  const shifted = Math.round(Number(`${magnitude}e${places}`));
  let rounded = Number(`${shifted}e${-places}`);
  //a number that already prints with an exponent cannot be shifted this way
  if (Number.isNaN(rounded)) rounded = Math.round(magnitude * 10 ** places) / 10 ** places;
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

function replace(value, search, replacement) {
  const from = toText(search);
  return from === '' ? toText(value) : toText(value).replaceAll(from, toText(replacement));
}

const firstNonNull = (...values) => values.find((value) => value !== null) ?? null;

export const FUNCTIONS = new Map([
  ['UPPER', { min: 1, max: 1, apply: (value) => toText(value).toUpperCase() }],
  ['LOWER', { min: 1, max: 1, apply: (value) => toText(value).toLowerCase() }],
  ['LENGTH', { min: 1, max: 1, apply: (value) => characters(value).length }],
  ['TRIM', { min: 1, max: 1, apply: (value) => toText(value).trim() }],
  ['SUBSTR', { min: 2, max: 3, apply: substr }],
  ['REPLACE', { min: 3, max: 3, apply: replace }],
  ['ABS', { min: 1, max: 1, apply: (value) => Math.abs(numberFor('ABS', value)) }],
  ['ROUND', { min: 1, max: 2, apply: round }],
  ['FLOOR', { min: 1, max: 1, apply: (value) => Math.floor(numberFor('FLOOR', value)) }],
  ['CEIL', { min: 1, max: 1, apply: (value) => Math.ceil(numberFor('CEIL', value)) }],
  ['COALESCE', { min: 1, max: Infinity, acceptsNull: true, apply: firstNonNull }],
  ['IFNULL', { min: 2, max: 2, acceptsNull: true, apply: firstNonNull }],
  ['NULLIF', { min: 2, max: 2, acceptsNull: true, apply: (a, b) => (a === b ? null : a) }],
]);
