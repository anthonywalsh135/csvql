//writes values as a line of csv. a field is quoted only when it has to be. null
//becomes an empty field and an empty string becomes "", so that reading the
//line back with the parser gives the values that were written.

function formatField(value, delimiter) {
  if (value === null) return '';
  const text = String(value);
  const needsQuotes =
    text === '' ||
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r');
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

//formats one record, without a line break on the end
export function formatRecord(values, delimiter = ',') {
  return values.map((value) => formatField(value, delimiter)).join(delimiter);
}
