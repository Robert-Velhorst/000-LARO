import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { eq } from 'drizzle-orm';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser } from '../factories';

(sqliteAvailable ? describe : describe.skip)('source throughput and quality parity', () => {
  let app: TestApp;
  beforeAll(async () => { app = await bootTestApp(); });
  afterAll(() => app?.cleanup());
  it('compares serial and bounded pipelined processing on identical originals', async () => {
    const { runSourceQueueStep } = await import('../../server/documentSourceQueue');
    const signatures: unknown[][] = [];
    const measurements: unknown[] = [];
    const count = 60;
    for (const variant of ['serial', 'pipelined', 'serial-repeat', 'pipelined-repeat']) {
      const owner = { id: `THROUGHPUT_${variant}`, role: 'user' };
      await app.db.insert(app.schema.users).values(buildUser(owner));
      const root = join(app.tmpDir, variant); mkdirSync(root);
      for (let index = 0; index < count; index++) {
        writeFileSync(join(root, `document-${String(index).padStart(3, '0')}.txt`),
          `Zaaknummer: PERF-2026-1234\nOp 2026-08-01 verklaart de gemeente dat het besluit is verzonden.\nDocument ${index}.\n`
          + 'De bewoner verzoekt om inzage in de bijbehorende stukken en bevestiging van ontvangst.\n'.repeat(40));
      }
      const caller = app.makeCaller(owner, 'session', true);
      const job = await caller.documentSources.start({ kind: 'local', root });
      const start = performance.now();
      let drained = false;
      for (let step = 0; step < 300; step++) {
        const results = variant.startsWith('serial') ? [await runSourceQueueStep(job.id)]
          : await Promise.all([
            runSourceQueueStep(job.id, 'import'), runSourceQueueStep(job.id, 'import'),
            runSourceQueueStep(job.id, 'analysis'), runSourceQueueStep(job.id, 'analysis'),
          ]);
        if (!results.some(Boolean)) { drained = true; break; }
      }
      const seconds = (performance.now() - start) / 1000;
      expect(drained).toBe(true);
      const rows = await app.db.select().from(app.schema.documentInbox).where(eq(app.schema.documentInbox.userId, owner.id));
      expect(rows).toHaveLength(count);
      expect(rows.filter((row: any) => !row.evidenceId || row.error).map((row: any) => ({ reason: row.reason, error: row.error })).slice(0, 3)).toEqual([]);
      const dossiers = await app.db.select().from(app.schema.cases).where(eq(app.schema.cases.userId, owner.id));
      expect(dossiers).toHaveLength(1);
      const signature = rows.sort((a: any, b: any) => a.fileName.localeCompare(b.fileName)).map((row: any) => {
        const analysis = JSON.parse(row.analysis);
        expect(analysis.coverage.complete).toBe(true);
        expect(analysis.providerStatus).toBe('not_requested');
        return { fileName: row.fileName, contentHash: row.contentHash, sourceText: row.sourceText, analysis };
      });
      signatures.push(signature);
      if (signatures.length > 1) expect(signature).toEqual(signatures[0]);
      measurements.push({ variant, documents: count, seconds: Number(seconds.toFixed(3)), docsPerSecond: Number((count / seconds).toFixed(2)) });
    }
    process.stdout.write(`SOURCE_THROUGHPUT ${JSON.stringify(measurements)}\nQuality gate: identical full extracted text, analysis, citations, hashes; one dossier per owner; no errors. Local rules, not OCR or LLM.\n`);
  }, 120000);
});
