#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER_ROOT = path.join(ROOT, "src", "renderer");
const BASELINE_PATH = path.join(ROOT, "scripts", "renderer-copy-baseline.json");
const WRITE = process.argv.includes("--write");
const LIST_INDEX = process.argv.indexOf("--list");
const USER_ATTRIBUTES = new Set(["aria-label", "alt", "placeholder", "title"]);
const NON_TRANSLATABLE_COPY = new Set([
  "&larr;",
  "/Users/me/Scans",
  "Gmail &amp; Drive",
  "Google Drive",
  "km",
  "name@example.com",
]);

function rendererFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (absolute === path.join(RENDERER_ROOT, "components", "ui")) return [];
      return rendererFiles(absolute);
    }
    return entry.isFile() && entry.name.endsWith(".tsx") ? [absolute] : [];
  });
}

function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}

function isCopy(value) {
  const normalized = normalize(value);
  if (!/[A-Za-zÀ-ÿ]/.test(normalized) || NON_TRANSLATABLE_COPY.has(normalized)) return false;
  if (/^[a-z0-9_-]+$/.test(normalized)) return false;
  if (/^[a-z][\w-]*(?:\.[\w-]+)+$/.test(normalized)) return false;
  if (!/[A-ZÀ-Þ]/.test(normalized)
    && /(?:^|\s)(?:bg|border|text|hover|focus|rotate|font)-/.test(normalized)) return false;
  return true;
}

function literalText(node, sourceFile) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.getText(sourceFile);
  return null;
}

function candidatesFor(file) {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const candidates = [];
  const add = (kind, value) => {
    const normalized = normalize(value);
    if (isCopy(normalized)) candidates.push(`${kind}:${normalized}`);
  };

  function visit(node) {
    if (ts.isJsxText(node)) add("jsx", node.text);
    if (ts.isJsxAttribute(node) && USER_ATTRIBUTES.has(node.name.getText(sourceFile))) {
      if (node.initializer && ts.isStringLiteral(node.initializer)) add("attribute", node.initializer.text);
    }
    if (ts.isConditionalExpression(node)) {
      let parent = node.parent;
      while (parent && !ts.isJsxAttribute(parent) && !ts.isCallExpression(parent)) parent = parent.parent;
      const translated = parent && ts.isCallExpression(parent)
        && ts.isIdentifier(parent.expression) && parent.expression.text === "t";
      const nonCopyAttribute = parent && ts.isJsxAttribute(parent)
        && !USER_ATTRIBUTES.has(parent.name.getText(sourceFile));
      if (!translated && !nonCopyAttribute) {
        const whenTrue = literalText(node.whenTrue, sourceFile);
        const whenFalse = literalText(node.whenFalse, sourceFile);
        if (whenTrue !== null) add("conditional", whenTrue);
        if (whenFalse !== null) add("conditional", whenFalse);
      }
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const isToast = ts.isPropertyAccessExpression(expression)
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === "toast";
      const isPrompt = ts.isPropertyAccessExpression(expression)
        && expression.expression.getText(sourceFile) === "window"
        && expression.name.text === "prompt";
      if (isToast || isPrompt) {
        const value = node.arguments[0] && literalText(node.arguments[0], sourceFile);
        if (value !== null && value !== undefined) add(isToast ? "toast" : "prompt", value);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return candidates.sort();
}

function snapshot() {
  return Object.fromEntries(rendererFiles(RENDERER_ROOT).sort().flatMap((file) => {
    const copy = candidatesFor(file);
    if (copy.length === 0) return [];
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    return [[relative, {
      count: copy.length,
      digest: crypto.createHash("sha256").update(JSON.stringify(copy)).digest("hex"),
    }]];
  }));
}

const current = snapshot();
if (LIST_INDEX >= 0) {
  const requested = process.argv[LIST_INDEX + 1];
  if (!requested) {
    console.error("Usage: node scripts/renderer-copy-audit.mjs --list <renderer-file>");
    process.exit(2);
  }
  const absolute = path.resolve(ROOT, requested);
  if (!absolute.startsWith(`${RENDERER_ROOT}${path.sep}`) || !fs.existsSync(absolute)) {
    console.error(`Renderer file not found: ${requested}`);
    process.exit(2);
  }
  for (const item of candidatesFor(absolute)) console.log(item);
  process.exit(0);
}
if (WRITE) {
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`Wrote renderer copy baseline for ${Object.keys(current).length} file(s).`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
const files = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
const drift = files.filter((file) => baseline[file]?.count !== current[file]?.count
  || baseline[file]?.digest !== current[file]?.digest);

if (drift.length > 0) {
  console.error("Uncatalogued renderer copy changed. Move new user-facing copy into shared/i18n.ts.");
  for (const file of drift) {
    console.error(`- ${file}: baseline ${baseline[file]?.count ?? 0}, current ${current[file]?.count ?? 0}`);
    const absolute = path.join(ROOT, file);
    if (fs.existsSync(absolute)) {
      for (const item of candidatesFor(absolute)) console.error(`    ${item}`);
    }
  }
  process.exit(1);
}

const count = Object.values(current).reduce((total, entry) => total + entry.count, 0);
console.log(`Renderer copy audit passed (${count} acknowledged legacy candidate(s); no drift).`);
