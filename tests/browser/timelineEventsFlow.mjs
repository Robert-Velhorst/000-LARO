import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export async function verifyTimelineEvents(page, database, ownerId, origin, output) {
  const db = new Database(database, { fileMustExist: true });
  try {
    db.prepare('INSERT INTO cases (id,userId,clientName) VALUES (?,?,?)').run('timeline-ui-case', ownerId, 'Chronology check');
    const upload = await page.request.post(`${origin}/api/trpc/evidenceFiles.upload`, {
      headers: { Origin: origin }, data: { json: { caseId: 'timeline-ui-case', title: 'Decision and receipt.txt', type: 'document', fileName: 'decision.txt', mimeType: 'text/plain', source: 'manual', base64: Buffer.from('Date of birth: 22 December 1979. Decision: 31 October 2022. Received: 7 November 2022.').toString('base64') } },
    });
    assert.equal(upload.status(), 200);
    const evidenceId = (await upload.json()).result.data.json.id;
    const insert = db.prepare('INSERT INTO timeline (id,caseId,userId,eventType,title,description,eventAt,metadata) VALUES (?,?,?,?,?,?,?,?)');
    for (const [index, date, title, description] of [
      [0, '1979-12-22', 'Date of birth mentioned', 'Background date mentioned in the decision, not its issue date.'],
      [1, '2022-10-31', 'Decision issued', 'The authority issued the decision.'],
      [2, '2022-11-07', 'Decision received', 'The applicant received the decision.'],
    ]) insert.run(`timeline-ui-${index}`, 'timeline-ui-case', ownerId, 'imported', title, description, Date.parse(`${date}T12:00:00Z`) / 1000, JSON.stringify({ evidenceId, legacySource: { actor: 'Applicant' } }));
    await page.goto(`${origin}/evidence?view=timeline&case=timeline-ui-case`);
    const region = page.getByRole('region', { name: 'Chronological events' });
    await expect(region.getByRole('listitem')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Show chronological events' })).toHaveAttribute('aria-pressed', 'true');
    await expect(region.getByRole('listitem').nth(1)).toContainText('31 oktober 2022');
    await page.screenshot({ path: path.join(output, 'timeline-events-desktop.png') });
    await region.getByRole('button', { name: 'Correct event Decision issued', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Save correction' })).toBeDisabled();
    await dialog.getByLabel('Event date', { exact: true }).fill('2022-11-01');
    await dialog.getByLabel('Reason for correction', { exact: true }).fill('Checked the issue date against the original document.');
    await page.screenshot({ path: path.join(output, 'timeline-correction-desktop.png') });
    const dialogAudit = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    assert.deepEqual(dialogAudit.violations.filter(item => ['serious', 'critical'].includes(item.impact)), []);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(db.prepare("SELECT count(*) AS n FROM timeline WHERE eventType = 'ai_timeline_correction'").get().n, 0);
    await region.getByRole('button', { name: 'Correct event Decision issued', exact: true }).click();
    await dialog.getByLabel('Event date', { exact: true }).fill('2022-11-01');
    await dialog.getByLabel('Reason for correction', { exact: true }).fill('Checked the issue date against the original document.');
    await dialog.getByRole('button', { name: 'Save correction' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(region.getByText('Owner corrected', { exact: true })).toBeVisible();
    await page.reload();
    await expect(region.getByRole('listitem').nth(1)).toContainText('1 november 2022');
    await region.getByText('Correction history (1)', { exact: true }).click();
    await region.locator('details').filter({ has: page.locator('summary', { hasText: 'Decision issued' }) }).last().locator('summary').click();
    await expect(region.getByText('2022-10-31 Applicant', { exact: true })).toBeVisible();
    await expect(region.getByText('2022-11-01 Applicant', { exact: true })).toBeVisible();
    await region.getByLabel('Search timeline events').fill('received');
    await expect(region.getByRole('listitem')).toHaveCount(1);
    await region.getByLabel('Search timeline events').fill('');
    const sourceRequest = page.waitForResponse(response => response.url().includes('evidenceFiles.getDownloadUrl'));
    await region.getByRole('button', { name: 'Open source document for Decision received' }).click();
    const sourceResponse = await sourceRequest;
    assert.equal(sourceResponse.status(), 200);
    const raw = await sourceResponse.json();
    const url = (Array.isArray(raw) ? raw[0] : raw).result.data.json.url;
    const source = await page.request.get(url);
    assert.equal(source.status(), 200);
    assert.match(await source.text(), /Date of birth: 22 December 1979/);
    await page.getByRole('button', { name: 'Show document map' }).click();
    await expect(page.getByRole('img', { name: 'Document history reconstruction' })).toBeVisible();
    await page.getByRole('button', { name: 'Show vertical map' }).click();
    await page.getByRole('button', { name: 'Show Gantt timeline' }).click();
    await expect(page.getByLabel('Evidence Gantt timeline')).toBeVisible();
    await page.getByRole('button', { name: 'Show chronological events' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'timeline-events-mobile.png') });
    const eventsAudit = await new AxeBuilder({ page }).include('[aria-label="Chronological events"]').analyze();
    assert.deepEqual(eventsAudit.violations.filter(item => ['serious', 'critical'].includes(item.impact)), []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await region.getByRole('button', { name: 'Correct event Decision issued', exact: true }).click();
    await expect(dialog.getByLabel('Event date', { exact: true })).toHaveValue('2022-11-01');
    await page.screenshot({ path: path.join(output, 'timeline-correction-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    console.log('PASS: chronological dates remain distinct, correction cancel/save/reload/history, original source bytes, search, map/vertical/Gantt, desktop/mobile layout. Real API and disposable database; no owner documents modified.');
  } finally { db.close(); }
}
