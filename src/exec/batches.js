//rows move between operators in batches: arrays of rows, each row an array of
//values. handing rows over one at a time would cost an async call per row, and
//a batch amortises that over about a thousand of them.

export const BATCH_SIZE = 1024;

//reads an input to the end and returns every row
export async function collect(input) {
  const rows = [];
  for await (const batch of input) {
    for (const row of batch) rows.push(row);
  }
  return rows;
}

//cuts a list of rows into batches
export function* inBatches(rows) {
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    yield rows.slice(start, start + BATCH_SIZE);
  }
}
