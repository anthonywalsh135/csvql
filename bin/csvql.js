#!/usr/bin/env node
import { main } from '../src/cli/main.js';

//a reader such as "head" that closes the pipe once it has enough is not a
//failure, so the write error it causes ends the program quietly
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error;
  process.exit(0);
});

process.exitCode = await main(process.argv.slice(2), process);
