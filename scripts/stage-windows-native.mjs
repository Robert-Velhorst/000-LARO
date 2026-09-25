#!/usr/bin/env node

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANVAS_PACKAGE = '@napi-rs/canvas-win32-x64-msvc';
const canvasPackage = JSON.parse(readFileSync(
  path.join(ROOT, 'node_modules', '@napi-rs', 'canvas', 'package.json'),
  'utf8',
));
const expectedVersion = canvasPackage.optionalDependencies?.[CANVAS_PACKAGE];
assert.match(
  expectedVersion ?? '',
  /^\d+\.\d+\.\d+$/,
  `${CANVAS_PACKAGE} must be pinned by @napi-rs/canvas`,
);

const destination = path.join(ROOT, 'node_modules', '@napi-rs', 'canvas-win32-x64-msvc');
const binding = path.join(destination, 'skia.win32-x64-msvc.node');

function assertWindowsX64Binding() {
  assert.ok(existsSync(binding), `Windows canvas binding is missing: ${binding}`);
  const binary = readFileSync(binding);
  assert.equal(binary.subarray(0, 2).toString('ascii'), 'MZ', `${binding} is not a PE binary`);
  const peOffset = binary.readUInt32LE(0x3c);
  assert.equal(binary.subarray(peOffset, peOffset + 4).toString('binary'), 'PE\0\0');
  assert.equal(binary.readUInt16LE(peOffset + 4), 0x8664, `${binding} is not x86-64 Windows PE`);
}

if (existsSync(binding)) {
  assertWindowsX64Binding();
  console.log(`PASS ${CANVAS_PACKAGE}@${expectedVersion} is staged for Windows packaging`);
  process.exit(0);
}

const stagingRoot = mkdtempSync(path.join(os.tmpdir(), 'laro-win-native-'));
try {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const install = spawnSync(
    npmCommand,
    [
      'install',
      '--prefix', stagingRoot,
      '--no-package-lock',
      '--ignore-scripts',
      '--force',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      `${CANVAS_PACKAGE}@${expectedVersion}`,
    ],
    { cwd: ROOT, stdio: 'inherit', windowsHide: true },
  );
  if (install.error) throw install.error;
  assert.equal(install.status, 0, `Could not stage ${CANVAS_PACKAGE}`);

  const stagedPackage = path.join(stagingRoot, 'node_modules', '@napi-rs', 'canvas-win32-x64-msvc');
  const stagedMetadata = JSON.parse(readFileSync(path.join(stagedPackage, 'package.json'), 'utf8'));
  assert.equal(stagedMetadata.version, expectedVersion, `Unexpected ${CANVAS_PACKAGE} version`);
  cpSync(stagedPackage, destination, { recursive: true, force: false, errorOnExist: true });
  assertWindowsX64Binding();
  console.log(`PASS staged ${CANVAS_PACKAGE}@${expectedVersion} for Windows packaging`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
