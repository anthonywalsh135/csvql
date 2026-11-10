//temporary directories of csv files for tests that need real files on disk

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

//creates a directory holding the given files, as { name: content }, and
//removes it again when the test finishes
export async function tempDir(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'csvql-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}
