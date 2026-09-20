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
  const driveProcedureRequests = [];
  const captureDriveProcedure = request => {
    if (/\/api\/trpc\/(?:autoCollection\.listDriveFolders|googleDrive\.)/.test(request.url())) {
      driveProcedureRequests.push(request.url());
    }
  };
  page.on('request', captureDriveProcedure);
  try {
    insertAccount.run('google-one', ownerId, 'gmail', 'first@example.test', 'connected', now, now);
    db.prepare('INSERT INTO cases (id,userId,clientName) VALUES (?,?,?)').run('google-case', ownerId, 'Multi-account check');
    db.prepare('INSERT INTO auto_collection_settings (id,caseId,userId,keywords,emailAccountIds,metadata,autoDownloadAttachments,autoDownloadGoogleDriveFiles) VALUES (?,?,?,?,?,?,?,?)')
      .run('google-settings', 'google-case', ownerId, '["contract"]', '[]', JSON.stringify({ googleDriveSources: [{ accountId: 'google-one', folderIds: ['folder-one'], folderNames: ['Legal documents'] }] }), 0, 0);
    // Only Google's external consent and folder responses are controlled; accounts and settings use the real API/database.
    await page.route('**/api/trpc/providerConnections.begin*', route => reply(route, { authUrl: `${origin}/test-google-consent?redirect_uri=${encodeURIComponent(`${origin}/api/oauth/gmail/callback`)}` }));
    await page.context().route('**/test-google-consent*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Controlled Google consent boundary</h1>' }));
    await page.route('**/api/trpc/autoCollection.listDriveFolders*', route => reply(route, {
      folders: [{ id: 'folder-two', name: 'Client files' }],
    }));
    const providerListUrl = `${origin}/api/trpc/providerConnections.list?input=${encodeURIComponent(JSON.stringify({ json: { provider: 'gmail' } }))}`;
    await expect.poll(async () => {
      const response = await page.request.get(providerListUrl);
      const body = await response.json();
      return body.result?.data?.json?.map(account => account.email) ?? [];
    }, { timeout: 15_000 }).toContain('first@example.test');
    await page.goto(`${origin}/evidence?view=connections&case=google-case`);
    const continueLater = page.getByRole('button', { name: 'Continue later', exact: true });
    if (await continueLater.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) {
      await continueLater.click();
    }
    assert.equal((await page.request.get(origin)).headers()['cross-origin-opener-policy'], 'same-origin-allow-popups');
    assert.equal((await page.request.get(`${origin}/api/ready`)).headers()['cross-origin-opener-policy'], 'same-origin');
    const section = page.getByRole('region', { name: 'Google accounts' });
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section.getByText('first@example.test', { exact: true })).toBeVisible({ timeout: 15_000 });
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
    await expect(section.getByText('Review shared Google disconnect', { exact: true })).toBeVisible();
    await expect(section.getByText('Gmail evidence collection will be removed', { exact: true })).toBeVisible();
    await expect(section.getByText('Google Drive evidence collection will be removed', { exact: true })).toBeVisible();
    await expect(section.getByText('Collected documents and other Google accounts stay unchanged.', { exact: true })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Revoke Gmail and Drive', exact: true })).toBeEnabled();
    await section.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_accounts').get().n, 2);
    await page.getByRole('tab', { name: 'Sources', exact: true }).click();
    await page.getByRole('button', { name: 'Browse Google Drive', exact: true }).click();
    await expect(page.getByText('Select Google Drive Sources', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('combobox', { name: 'Google account', exact: true }).click();
    await page.getByRole('option', { name: 'second@example.test', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select folder Client files', exact: true })).toBeVisible();
    await expect(page.getByText('Folder Preview', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/import folder/i)).toHaveCount(0);
    await page.getByRole('button', { name: 'Select folder Client files', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'google-drive-source-selector-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'google-drive-source-selector-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Confirm Selection', exact: true }).click();
    await page.getByRole('tab', { name: 'Sources', exact: true }).click();
    await expect(page.getByTestId('drive-source-selection')).toHaveCount(2);
    assert.ok(driveProcedureRequests.length > 0);
    assert.ok(driveProcedureRequests.every(url => url.includes('/api/trpc/autoCollection.listDriveFolders')));
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await expect.poll(() => JSON.parse(db.prepare('SELECT metadata FROM auto_collection_settings WHERE id = ?').get('google-settings').metadata).googleDriveSources.length).toBe(2);
    await page.reload();
    if (await continueLater.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) {
      await continueLater.click();
    }
    await page.getByRole('tab', { name: 'Sources', exact: true }).click();
    await expect(page.getByTestId('drive-source-selection')).toHaveCount(2);
    await page.screenshot({ path: path.join(output, 'google-accounts-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'google-accounts-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log('PASS: add a second account without early OAuth completion, auto-refresh and popup close, disconnect cancellation preserves both accounts, canonical Drive source selection survives save/reload, and desktop/mobile layouts fit. Google consent and listing mocked only in disposable test.');
  } finally {
    page.off('request', captureDriveProcedure);
    db.close();
  }
}
