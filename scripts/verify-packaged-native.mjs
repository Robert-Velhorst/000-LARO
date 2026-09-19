#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const resources = path.join(
  ROOT,
  'release',
  project.version,
  'win-unpacked',
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'better-sqlite3',
);
const windowsBinding = path.join(resources, 'prebuilds', 'win32-x64.node');
const legacyBinding = path.join(resources, 'build', 'Release', 'better_sqlite3.node');
const canvasBinding = path.join(
  ROOT,
  'release',
  project.version,
  'win-unpacked',
  'resources',
  'app.asar.unpacked',
  'node_modules',
  '@napi-rs',
  'canvas-win32-x64-msvc',
  'skia.win32-x64-msvc.node',
);
const portable = path.join(ROOT, 'release', project.version, `LARO Desktop ${project.version}.exe`);

function peMachine(file) {
  const binary = readFileSync(file);
  assert.equal(binary.subarray(0, 2).toString('ascii'), 'MZ', `${file} is not a PE binary`);
  const peOffset = binary.readUInt32LE(0x3c);
  assert.equal(binary.subarray(peOffset, peOffset + 4).toString('binary'), 'PE\0\0');
  return binary.readUInt16LE(peOffset + 4);
}

assert.ok(existsSync(portable), `Portable Windows executable is missing: ${portable}`);
peMachine(portable);
assert.ok(existsSync(windowsBinding), `Packaged Win64 SQLite binding is missing: ${windowsBinding}`);
assert.equal(
  peMachine(windowsBinding),
  0x8664,
  'Packaged SQLite binding is not x86-64 Windows PE',
);
assert.equal(
  existsSync(legacyBinding),
  false,
  'Package contains a host-compiled legacy SQLite binding',
);
assert.ok(existsSync(canvasBinding), `Packaged Win64 canvas binding is missing: ${canvasBinding}`);
assert.equal(
  peMachine(canvasBinding),
  0x8664,
  'Packaged canvas binding is not x86-64 Windows PE',
);

console.log('PASS packaged Windows executable, SQLite binding, and canvas binding are PE/x64 candidates');
