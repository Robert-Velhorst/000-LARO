import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export async function verifySourceProgress(page, database, ownerId, origin, output) {
  const db = new Database(database, { fileMustExist: true });
  const id = randomUUID(), timestamp = Math.floor(Date.now() / 1000);
  try {
    db.prepare('INSERT INTO document_source_jobs (id,userId,kind,config,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
      .run(id, ownerId, 'local', JSON.stringify({ kind: 'local', root: 'C:\\Synthetic-UI-Test' }), 'running', timestamp, timestamp);
    const insert = db.prepare('INSERT INTO document_source_work (id,jobId,userId,kind,payload,label,isDocument,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (let index = 0; index < 100; index++) insert.run(`${id}-${index}`, id, ownerId, 'inbox_analysis', '{}', `Test task ${index}`, 0, 'queued', timestamp, timestamp);
    await page.goto(`${origin}/evidence?view=inbox`);
    const block = page.getByLabel('Source processing progress');
    const bar = block.getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    await expect(block).toContainText('Measuring processing speed');
    for (let step = 0; step < 3; step++) {
      await page.waitForTimeout(5200);
      for (let index = step * 5; index < (step + 1) * 5; index++) db.prepare('UPDATE document_source_work SET status = ? WHERE id = ?').run('done', `${id}-${index}`);
      await expect(bar).toHaveAttribute('aria-valuenow', String((step + 1) * 5), { timeout: 10000 });
    }
    await expect(block).toContainText(/Known queue ETA: about \d/, { timeout: 15000 });
    await expect(block).toContainText('15 / 100 tasks handled');
    await block.screenshot({ path: path.join(output, 'source-progress-eta.png') });
    const axe = await new AxeBuilder({ page }).include('[aria-label="Source processing progress"]').analyze();
    assert.deepEqual(axe.violations.map(item => item.id), []);
    db.prepare('UPDATE document_source_jobs SET status = ? WHERE id = ?').run('paused', id);
    await expect(block).toContainText('Known queue ETA: Paused', { timeout: 10000 });
    await expect(bar).toHaveAttribute('aria-valuenow', '15');
    insert.run(`${id}-folder`, id, ownerId, 'local_directory', '{}', 'Test folder', 0, 'queued', timestamp, timestamp);
    await expect(block).toContainText('Final total and overall ETA are unknown', { timeout: 10000 });
    await expect(bar).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await block.screenshot({ path: path.join(output, 'source-progress-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log('PASS: source progress updates from API counts, numeric ETA appears from measured throughput, pause hides ETA, discovery keeps bar visible, ARIA percentage and mobile layout verified.');
  } finally { db.close(); }
}
