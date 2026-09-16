#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const SHA_REF = /^[0-9a-f]{40}$/i;

function workflowFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return workflowFiles(path);
    return ['.yml', '.yaml'].includes(extname(entry.name)) ? [path] : [];
  });
}

const failures = [];
let externalActions = 0;

for (const file of workflowFiles(WORKFLOWS)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (!match) return;
    const spec = match[1];
    if (spec.startsWith('./') || spec.startsWith('docker://')) return;
    externalActions += 1;
    const separator = spec.lastIndexOf('@');
    const ref = separator === -1 ? '' : spec.slice(separator + 1);
    if (!SHA_REF.test(ref)) {
      failures.push(`${relative(ROOT, file)}:${index + 1}: ${spec}`);
    }
  });
}

if (failures.length > 0) {
  console.error('External workflow actions must be pinned to a full 40-character commit SHA:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`workflow-action-pins: ${externalActions} external action reference(s) are immutable.`);
