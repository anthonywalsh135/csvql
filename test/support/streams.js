//stand-ins for the terminal, so the command line can be run inside a test

import { Readable, Writable } from 'node:stream';

import { main } from '../../src/cli/main.js';

//a writable stream that remembers everything written to it
export function capture() {
  let written = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      written += chunk;
      done();
    },
  });
  return { stream, text: () => written };
}

//runs the command line and returns its exit status and what it printed
export async function run(args, input = '') {
  const stdout = capture();
  const stderr = capture();
  const streams = { stdin: Readable.from([input]), stdout: stdout.stream, stderr: stderr.stream };
  const status = await main(args, streams);
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}
