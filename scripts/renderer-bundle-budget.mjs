#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "dist", "renderer", "assets");
const KIB = 1024;
const budgets = {
  javascriptChunk: 200 * KIB,
  stylesheet: 100 * KIB,
  evidenceRoute: 80 * KIB,
};

if (!existsSync(ASSETS)) {
  console.error("Renderer assets are missing. Run the production renderer build first.");
  process.exit(1);
}

const assets = readdirSync(ASSETS)
  .filter((name) => [".js", ".css"].includes(extname(name)))
  .map((name) => ({ name, bytes: statSync(join(ASSETS, name)).size }));

const javascript = assets.filter((asset) => asset.name.endsWith(".js"));
const stylesheets = assets.filter((asset) => asset.name.endsWith(".css"));
const evidenceRoute = javascript.find((asset) => /^Evidence-[A-Za-z0-9_-]+\.js$/.test(asset.name));
const failures = [];

for (const asset of javascript) {
  if (asset.bytes > budgets.javascriptChunk) {
    failures.push(`${asset.name} is ${asset.bytes} bytes; limit is ${budgets.javascriptChunk}`);
  }
}

for (const asset of stylesheets) {
  if (asset.bytes > budgets.stylesheet) {
    failures.push(`${asset.name} is ${asset.bytes} bytes; limit is ${budgets.stylesheet}`);
  }
}

if (!evidenceRoute) {
  failures.push("The split Evidence route chunk was not found.");
} else if (evidenceRoute.bytes > budgets.evidenceRoute) {
  failures.push(`${evidenceRoute.name} is ${evidenceRoute.bytes} bytes; Evidence route limit is ${budgets.evidenceRoute}`);
}

const largestJavascript = javascript.toSorted((left, right) => right.bytes - left.bytes)[0];
const largestStylesheet = stylesheets.toSorted((left, right) => right.bytes - left.bytes)[0];

console.log(`Largest JavaScript chunk: ${largestJavascript?.name ?? "none"} (${largestJavascript?.bytes ?? 0} bytes)`);
console.log(`Largest stylesheet: ${largestStylesheet?.name ?? "none"} (${largestStylesheet?.bytes ?? 0} bytes)`);
console.log(`Evidence route: ${evidenceRoute?.name ?? "missing"} (${evidenceRoute?.bytes ?? 0} bytes)`);

if (failures.length > 0) {
  console.error("Renderer bundle budget failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("Renderer bundle budgets passed.");
