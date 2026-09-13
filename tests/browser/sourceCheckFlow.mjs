import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export async function verifySourceChecks(page, database, ownerId, origin, output) {
  const db = new Database(database, { fileMustExist: true });
  const id = randomUUID(), legacyId = randomBytes(32).toString('hex'), checkedId = randomBytes(32).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    db.prepare('INSERT INTO document_source_jobs (id,userId,kind,config,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
      .run(id, ownerId, 'local', JSON.stringify({ kind: 'local', root: 'C:\\Synthetic-Skip-Test' }), 'paused', timestamp, timestamp);
    const insert = db.prepare('INSERT INTO document_source_work (id,jobId,userId,kind,payload,label,isDocument,status,error,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    insert.run(legacyId, id, ownerId, 'local_file', '{}', 'legacy-source.bin', 1, 'skipped', 'Old unsupported format decision', timestamp, timestamp);
    insert.run(checkedId, id, ownerId, 'local_file', '{}', 'evidence-empty.txt', 1, 'needs_review', 'Empty file; relevance is unknown', timestamp, timestamp);
    db.prepare('INSERT INTO audit_logs (id,userId,action,entityType,entityId,details,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), ownerId, 'source.item_checked', 'document_source_work', checkedId, JSON.stringify({ check: {
        policyVersion: 1, checkedAt: new Date().toISOString(), outcome: 'needs_review', code: 'empty_file', basis: 'filesystem', contentAssessed: false, facts: { sizeBytes: 0 },
      } }), timestamp);
    await page.goto(`${origin}/evidence?view=inbox`);
    const source = page.getByRole('article', { name: 'Local folder source' }).filter({ has: page.getByRole('button', { name: 'Review exclusions' }) });
    await source.getByRole('button', { name: 'Review exclusions' }).click();
    await expect(source).toContainText('Previous skip has no recorded verification');
    await expect(source).toContainText('1 source items need review');
    await source.getByText(/Import limitation checked/).click();
    await expect(source).toContainText('Contents and legal relevance were not assessed');
    await expect(source).toContainText('sizeBytes: 0');
    await source.screenshot({ path: path.join(output, 'source-check-desktop.png') });
    const axe = await new AxeBuilder({ page }).include('article[aria-label="Local folder source"]').analyze();
    assert.deepEqual(axe.violations.map(item => item.id), []);
    await source.getByRole('button', { name: 'Recheck legacy-source.bin', exact: true }).click();
    await expect(source).toContainText('Check queued. Resume the paused source');
    await expect(source.getByText('legacy-source.bin', { exact: true })).toHaveCount(0);
    assert.equal(db.prepare('SELECT status FROM document_source_work WHERE id = ?').get(legacyId).status, 'queued');
    assert.equal(db.prepare('SELECT status FROM document_source_jobs WHERE id = ?').get(id).status, 'paused');
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_logs WHERE entityId = ? AND action = ?').get(legacyId, 'source.item_recheck_requested').n, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await source.screenshot({ path: path.join(output, 'source-check-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (let index = 0; index < 4; index++) insert.run(randomBytes(32).toString('hex'), id, ownerId, 'local_file', '{}', `failed-source-${index}.txt`, 1, 'failed', 'Source could not be read (EACCES)', timestamp + index + 1, timestamp + index + 1);
    const failures = source.getByRole('region', { name: 'Source failures' });
    await expect(failures).toBeVisible({ timeout: 10000 });
    await expect(failures).toContainText('4 processing failures');
    await expect(failures).toContainText('Access to the file was denied');
    await expect(failures).toContainText('Check file permissions');
    await expect(failures).toContainText('Import not confirmed');
    await failures.getByRole('button', { name: 'View all failures' }).click();
    await expect(source.locator('ul > li')).toHaveCount(4);
    await expect(source.locator('ul')).toContainText('failed-source-0.txt');
    await source.screenshot({ path: path.join(output, 'source-failures-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1440, height: 900 });
    await source.screenshot({ path: path.join(output, 'source-failures-desktop.png') });
    const deferredId = randomBytes(32).toString('hex');
    insert.run(deferredId, id, ownerId, 'local_file', JSON.stringify({ path: 'C:\\Synthetic-Skip-Test\\assets\\icon.png', screening: {
      version: 1, tier: 'low', checkedAt: new Date().toISOString(), sourceVersion: 'test-only-version', fileBytes: 1024, sampledBytes: 0, elapsedMs: 1,
      reasons: ['Software directory context', 'Image content has not been read or OCRed; relevance remains unconfirmed'],
    } }), 'assets/icon.png', 1, 'deferred', 'Fast skim: likely software material. Deferred for review, not declared irrelevant.', timestamp + 9, timestamp + 9);
    const screening = source.getByRole('region', { name: 'Quick source screening' });
    await expect(screening).toBeVisible({ timeout: 10000 });
    await expect(screening).toContainText('0 text-sampled');
    await expect(screening).toContainText('Bytes actually sampled: 0.00 MiB');
    await screening.getByRole('button', { name: 'Review 1 deferred items' }).click();
    await source.getByRole('button', { name: 'Analyze anyway', exact: true }).click();
    await expect(source.getByRole('button', { name: 'Analyze anyway', exact: true })).toHaveCount(0);
    const deferred = db.prepare('SELECT status,payload FROM document_source_work WHERE id = ?').get(deferredId);
    assert.equal(deferred.status, 'queued');
    assert.equal(JSON.parse(deferred.payload).allowLowPriority, true);
    assert.equal(db.prepare('SELECT status FROM document_source_jobs WHERE id = ?').get(id).status, 'paused');
    await page.setViewportSize({ width: 390, height: 844 });
    await screening.screenshot({ path: path.join(output, 'quick-screening-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log('PASS: quick-screening metrics distinguish file sizes from sampled bytes; deferred material can be explicitly included without unpausing.');
    console.log('PASS: new failures appear automatically with file, cause, recovery guidance and accurate import state; all failures are filterable on mobile and desktop.');
    console.log('PASS: exclusions filter, legacy unverified warning, factual check details, recheck request and audit, pause preservation, desktop/mobile layout and accessibility.');
  } finally { db.close(); }
}
