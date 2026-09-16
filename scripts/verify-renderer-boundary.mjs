#!/usr/bin/env node
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = join(ROOT, 'src', 'renderer');
const CONFIG = join(ROOT, 'tsconfig.renderer.json');
const config = ts.readConfigFile(CONFIG, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
const sourceExtensions = new Set(['.ts', '.tsx']);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!sourceExtensions.has(extname(path)) || path.endsWith('.d.ts')) return [];
    return [resolve(path)];
  });
}

const reachable = new Set();
function visit(file) {
  const absolute = resolve(file);
  if (reachable.has(absolute)) return;
  reachable.add(absolute);
  const imports = ts.preProcessFile(readFileSync(absolute, 'utf8'), true, true).importedFiles;
  for (const imported of imports) {
    const result = ts.resolveModuleName(imported.fileName, absolute, parsed.options, ts.sys).resolvedModule;
    if (!result) continue;
    const target = resolve(result.resolvedFileName);
    if (target.startsWith(RENDERER) && sourceExtensions.has(extname(target))) visit(target);
  }
}

visit(join(RENDERER, 'main.tsx'));
const unreachable = sourceFiles(RENDERER).filter((file) => !reachable.has(file));

if (unreachable.length > 0) {
  console.error('Renderer source files outside the mounted product graph:');
  unreachable.forEach((file) => console.error(`- ${relative(ROOT, file)}`));
  console.error('Mount and test the file, delete it, or move historical work to archive/renderer/.');
  process.exit(1);
}

console.log(`renderer-boundary: ${sourceFiles(RENDERER).length} maintained source files are reachable from main.tsx.`);
