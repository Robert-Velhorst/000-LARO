#!/usr/bin/env node
/**
 * Phase 031 — local development one-command experience.
 *
 * Idempotent setup: verifies Node, creates a `.env` from `.env.example` if
 * missing, and prints the next steps. Run via `npm run setup`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (m) => console.log(`[setup] ${m}`);

// 1. Node version check.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 22 || minor < 12) {
  console.error(`[setup] Node 24.21+ in the Node 24 LTS line is required; found ${process.versions.node}.`);
  process.exit(1);
}
log(`Node ${process.versions.node} OK.`);

// 2. Ensure a .env exists (copied from the template, never overwriting).
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');
if (!fs.existsSync(envPath)) {
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    log('Created .env from .env.example (fill in secrets before production use).');
  } else {
    log('No .env.example found; skipping .env creation.');
  }
} else {
  log('.env already present; leaving it untouched.');
}

// 3. Next-step guidance.
log('Setup complete. Next:');
log('  npm run dev         # Electron desktop app (renderer + main)');
log('  npm run dev:server  # standalone API server on http://localhost:3000');
log('  npm run doctor      # self-diagnostic health check');
log('  npm test            # run the test suite');
