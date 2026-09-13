import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const { extractImageText, extractImageBatchText } = require('../dist/server/server/ocr.js');
const image = readFileSync(new URL('../tests/fixtures/ocr-dutch-decision.png', import.meta.url));
const count = 6;
let reference;
const measurements = [];
for (const variant of ['individual', 'batch', 'individual-repeat', 'batch-repeat']) {
  const start = performance.now();
  const results = [];
  if (variant.startsWith('batch')) results.push(...await extractImageBatchText(Array(count).fill(image)));
  else for (let i = 0; i < count; i++) results.push(await extractImageText(image));
  const seconds = (performance.now() - start) / 1000;
  for (const result of results) {
    const signature = { text: result.text, confidence: result.confidence, language: result.language };
    if (!reference) reference = signature;
    assert.equal(result.text.replace(/\s+/g, ' ').trim(), 'Besluit 14 juli 2026 EUR 1250', 'OCR must match the visible fixture text');
    assert.deepEqual(signature, reference, 'OCR text and confidence must remain identical');
  }
  measurements.push({ variant, images: count, seconds: Number(seconds.toFixed(3)), imagesPerSecond: Number((count / seconds).toFixed(2)) });
}
console.log(JSON.stringify({ measurements, quality: 'Identical OCR text, confidence and language on repeated Dutch fixture; no LLM or dossier processing measured.' }, null, 2));
