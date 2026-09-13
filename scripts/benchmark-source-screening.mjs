import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { executeLocalSourceWork, grantLocalSourceRoot, screenLocalSourceBatch } = require('../dist/server/server/localDocumentSource.js');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(repo, '.cache', 'screen-benchmark');
await mkdir(cache, { recursive: true });
const corpus = await mkdtemp(path.join(cache, 'corpus-'));
const canonical = await realpath(corpus);
const manyFiles = process.argv.includes('--many-files');
const fileCount = manyFiles ? 10000 : 300, fileSize = manyFiles ? 128 * 1024 : 4 * 1024 * 1024;
const reportPath = path.join(cache, manyFiles ? 'many-files.json' : 'large-files.json');
try {
  await mkdir(path.join(corpus, 'src'));
  for (let index = 0; index < fileCount; index++) {
    const technical = index % 5 === 0;
    const buffer = Buffer.alloc(fileSize, technical ? 'import os\n# generated fixture content\n' : 'Ordinary notes without a decisive classification signal.\n');
    if (index % 10 === 0) buffer.write('\nZaaknummer: BENCH-2026-123\nBesluit van de gemeente.\n', buffer.length - 80);
    await writeFile(path.join(corpus, technical ? 'src' : '', `document-${index}.${technical ? 'py' : 'txt'}`), buffer);
  }
  const root = await grantLocalSourceRoot(corpus);
  const started = performance.now();
  const directories = [{ path: root }], paths = [];
  while (directories.length) {
    const page = await executeLocalSourceWork({ kind: 'local', root }, 'local_page', directories.shift());
    for (const child of page.children || []) {
      if (child.kind === 'local_page') directories.push(child.payload);
      else paths.push(child.payload.path);
    }
  }
  const screens = [];
  for (let offset = 0; offset < paths.length; offset += 128) screens.push(...await screenLocalSourceBatch(root, paths.slice(offset, offset + 128)));
  const seconds = (performance.now() - started) / 1000;
  const report = { measuredAt: new Date().toISOString(), scope: 'Local inventory and bounded sampling; excludes corpus creation, database writes, import, OCR and model analysis',
    corpus: `${fileCount} synthetic text/source-code files of ${fileSize} bytes each; recently written, OS cache may be warm`,
    files: screens.length, fileBytes: screens.reduce((sum, row) => sum + row.fileBytes, 0),
    bytesActuallyRead: screens.reduce((sum, row) => sum + row.sampledBytes, 0), seconds,
    priorities: screens.filter(row => row.tier === 'priority').length, lowPriority: screens.filter(row => row.tier === 'low').length,
    unavailable: screens.filter(row => row.tier === 'unavailable').length,
    targetMet: false };
  report.targetMet = report.fileBytes > 1e9 && seconds < 60 && report.unavailable === 0 && report.files === fileCount;
  assert.equal(report.priorities, fileCount / 10, 'Legal tail signals must override software context');
  assert.equal(report.lowPriority, fileCount / 10);
  assert.equal(report.files, fileCount);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.targetMet) process.exitCode = 1;
} finally {
  // Delete only the temporary corpus created in this invocation, never a supplied source path.
  const resolved = await realpath(corpus);
  const relative = path.relative(await realpath(cache), resolved);
  if (resolved !== canonical || !relative.startsWith('corpus-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe benchmark cleanup target');
  await rm(resolved, { recursive: true, force: false });
}
