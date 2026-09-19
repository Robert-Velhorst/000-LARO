import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect } from '@playwright/test';

export async function verifyGoogleAccounts(page, database, ownerId, origin, output) {
  const db = new Database(database, { fileMustExist: true });
  const now = Math.floor(Date.now() / 1000);
  const insertAccount = db.prepare('INSERT INTO email_accounts (id,userId,provider,email,status,connectedAt,updatedAt) VALUES (?,?,?,?,?,?,?)');
  const reply = async (route, json) => {
    const result = { result: { data: { json } } };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(new URL(route.request().url()).searchParams.has('batch') ? [result] : result) });
  };
  try {
    insertAccount.run('google-one', ownerId, 'gmail', 'first@example.test', 'connected', now, now);
    db.prepare('INSERT INTO cases (id,userId,clientName) VALUES (?,?,?)').run('google-case', ownerId, 'Multi-account check');
    db.prepare('INSERT INTO auto_collection_settings (id,caseId,userId,keywords,emailAccountIds,metadata,autoDownloadAttachments,autoDownloadGoogleDriveFiles) VALUES (?,?,?,?,?,?,?,?)')
      .run('google-settings', 'google-case', ownerId, '["contract"]', '[]', JSON.stringify({ googleDriveSources: [{ accountId: 'google-one', folderIds: ['folder-one'], folderNames: ['Legal documents'] }] }), 0, 0);
    // Only Google's external consent and folder responses are controlled; accounts and settings use the real API/database.
    await page.route('**/api/trpc/providerConnections.begin*', route => reply(route, { authUrl: `${origin}/test-google-consent?redirect_uri=${encodeURIComponent(`${origin}/api/oauth/gmail/callback`)}` }));
    await page.context().route('**/test-google-consent*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Controlled Google consent boundary</h1>' }));
    await page.route('**/api/trpc/googleDrive.listFolders*', route => reply(route, { folders: [] }));
    await page.goto(`${origin}/evidence?view=connections&case=google-case`);
    assert.equal((await page.request.get(origin)).headers()['cross-origin-opener-policy'], 'same-origin-allow-popups');
    assert.equal((await page.request.get(`${origin}/api/ready`)).headers()['cross-origin-opener-policy'], 'same-origin');
    const section = page.getByRole('region', { name: 'Google accounts' });
    await expect(section.getByText('first@example.test', { exact: true })).toBeVisible();
    const popupPromise = page.waitForEvent('popup');
    await section.getByRole('button', { name: 'Add Google account', exact: true }).click();
    const popup = await popupPromise;
    await expect(section.getByRole('button', { name: 'Cancel connection' })).toBeVisible();
    await page.waitForTimeout(2200);
    assert.equal(popup.isClosed(), false, 'Existing account must not finish the new connection');
    insertAccount.run('google-two', ownerId, 'gmail', 'second@example.test', 'connected', now + 5, now + 5);
    await expect(section.getByText('second@example.test', { exact: true })).toBeVisible({ timeout: 12000 });
    await expect(section.getByRole('button', { name: 'Add Google account', exact: true })).toBeEnabled();
    await expect.poll(() => popup.isClosed()).toBe(true);
    await section.getByRole('button', { name: 'Disconnect second@example.test', exact: true }).click();
    await expect(section.getByText(/Other accounts and collected documents stay unchanged/)).toBeVisible();
    await section.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_accounts').get().n, 2);
    await page.getByRole('tab', { name: 'Sources', exact: true }).click();
    await page.getByRole('button', { name: 'Browse Google Drive', exact: true }).click();
    await page.getByRole('combobox', { name: 'Google account', exact: true }).click();
    await page.getByRole('option', { name: 'second@example.test', exact: true }).click();
    await page.getByRole('button', { name: 'Select all of My Drive', exact: true }).click();
    await page.getByRole('tab', { name: 'Sources', exact: true }).click();
    await expect(page.getByTestId('drive-source-selection')).toHaveCount(2);
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await expect.poll(() => JSON.parse(db.prepare('SELECT metadata FROM auto_collection_settings WHERE id = ?').get('google-settings').metadata).googleDriveSources.length).toBe(2);
    await page.reload();
    await page.getByRole('tab', { name: 'Sources', exact: true }).click();
    await expect(page.getByTestId('drive-source-selection')).toHaveCount(2);
    await page.screenshot({ path: path.join(output, 'google-accounts-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'google-accounts-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log('PASS: add a second account without early OAuth completion, auto-refresh and popup close, disconnect cancellation preserves both accounts, two Drive selections survive save/reload, desktop/mobile fit. Google consent and listing mocked only in disposable test.');
  } finally { db.close(); }
}
