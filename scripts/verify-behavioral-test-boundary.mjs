#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TEST_ROOTS = ["tests/acceptance", "tests/smoke"];

function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) files.push(...filesBelow(absolute));
    else if (/\.test\.[cm]?[jt]sx?$/.test(entry)) files.push(absolute);
  }
  return files;
}

const violations = [];
const files = TEST_ROOTS.flatMap((directory) => filesBelow(join(ROOT, directory)));
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const importsFileReader = /from\s+["'](?:node:)?fs["']|require\(["'](?:node:)?fs["']\)/.test(source);
  if (importsFileReader) {
    violations.push(`${relative(ROOT, file)} imports fs; source/config scans are not acceptance evidence`);
  }
}

if (violations.length > 0) {
  console.error("Behavioral test boundary failed:\n");
  for (const violation of violations) console.error(`- ${violation}`);
  console.error("\nMove architecture/configuration tripwires to an appropriate security test and retain a behavioral owner for the claim.");
  process.exit(1);
}

console.log(`Behavioral test boundary passed: ${files.length} acceptance/smoke files use executable product boundaries, not source-file readers.`);
