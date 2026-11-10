//the column types, and how a field of text becomes a value of each one.
//
//conversion never fails. a field that does not fit the type of its column is
//left as text, the way sqlite treats a value that does not match a column's
//affinity. one stray "n/a" in a column of numbers should not make the whole
//file unreadable.

//a whole number with no leading zeros and at most 15 digits. anything longer
//cannot be held exactly in a double and is far more likely to be an account
//number than something to do arithmetic on. leading zeros are refused for the
//same reason: "02134" is a postcode, and reading it as 2134 would destroy it.
const INTEGER = /^-?(?:0|[1-9]\d{0,14})$/;
const DECIMAL = /^-?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$|^-?\d+[eE][-+]?\d+$/;
const BOOLEAN = /^(?:true|false)$/i;

const MINUS = 45;
const ZERO = 48;

const isNumeric = (text) => INTEGER.test(text) || DECIMAL.test(text);

//chooses the narrowest type that every one of the values fits
export function inferType(values) {
  if (values.length === 0) return 'text';
  if (values.every((value) => BOOLEAN.test(value))) return 'boolean';
  if (values.every((value) => INTEGER.test(value))) return 'integer';
  if (values.every(isNumeric)) return 'real';
  return 'text';
}

function toNumber(text) {
  return isNumeric(text) ? Number(text) : text;
}

//most numeric columns hold integers, so those are read digit by digit here
//instead of paying for a regex test and a call to Number() on every field.
//anything unusual falls through to the general path.
function toInteger(text) {
  const negative = text.charCodeAt(0) === MINUS;
  const first = negative ? 1 : 0;
  const digits = text.length - first;
  if (digits === 0 || digits > 15) return toNumber(text);
  if (digits > 1 && text.charCodeAt(first) === ZERO) return toNumber(text);

  let value = 0;
  for (let i = first; i < text.length; i++) {
    const digit = text.charCodeAt(i) - ZERO;
    if (digit < 0 || digit > 9) return toNumber(text);
    value = value * 10 + digit;
  }
  return negative && value !== 0 ? -value : value;
}

function toBoolean(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  const lower = text.toLowerCase();
  if (lower === 'true') return true;
  return lower === 'false' ? false : text;
}

const CONVERTERS = { integer: toInteger, real: toNumber, boolean: toBoolean, text: null };

//the function that turns a field into a value of the given type, or null when
//the text is already the value
export function converterFor(type) {
  return CONVERTERS[type];
}
