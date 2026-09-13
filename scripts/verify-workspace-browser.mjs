#!/usr/bin/env node
// Observe the handoff's real browser flows, using only their disposable workspaces.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = new URL('../out/workspace-verification/', import.meta.url);
mkdirSync(output, { recursive: true });
const report = { consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [] };
const launch = chromium.launch.bind(chromium);
chromium.launch = async (options) => {
  const browser = await launch({ ...options, channel: process.env.LARO_BROWSER_CHANNEL || 'chrome' });
  const createContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await createContext(options);
    context.on('page', (page) => {
      page.on('console', (entry) => { if (entry.type() === 'error') report.consoleErrors.push(entry.text()); });
      page.on('pageerror', (error) => report.pageErrors.push(error.message));
      page.on('requestfailed', (request) => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
      page.on('response', (response) => { if (response.status() >= 400) report.badResponses.push({ url: response.url(), status: response.status() }); });
    });
    return context;
  };
  return browser;
};
try {
  await import('../tests/browser/workspaceAccess.mjs');
  report.flowPassed = true;
} catch (error) {
  report.flowPassed = false;
  report.error = error instanceof Error ? error.stack || error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  // The existing outage tests deliberately abort auth and restart a server.
  // Retain those network errors in the report; do not claim zero console errors.
  report.notes = ['Auth and socket connection failures are expected during the deliberate outage/restart checks.', 'Google consent and listing responses are test doubles, not live provider acceptance.'];
  writeFileSync(new URL('result.json', output), JSON.stringify(report, null, 2) + '\n');
  console.log(`Browser observation report: ${fileURLToPath(new URL('result.json', output))}`);
}
