import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

describe('KvK registry presentation contract', () => {
  it('separates sourced registry facts from explicitly review-only triage', () => {
    const service = readFileSync(join(ROOT, 'server/kvkIntegration.ts'), 'utf8');
    const panel = readFileSync(join(ROOT, 'src/renderer/components/PublicRecordsPanel.tsx'), 'utf8');

    expect(service).not.toContain('potential shell company');
    expect(service).not.toContain('Company appears to be in good standing');
    expect(service).not.toContain('financial difficulties confirmed');
    expect(service).toContain('fieldProvenance');
    expect(service).toContain('retrievedAt');
    expect(service).toContain('reviewOnly: true');

    expect(panel).toContain('publicRecords.registrySource');
    expect(panel).toContain('publicRecords.sourceField');
    expect(panel).toContain('publicRecords.reviewTriage');
    expect(panel).toContain('publicRecords.triageDisclaimer');
    expect(panel).toContain('publicRecords.datasetLimitations');
    expect(panel).not.toContain('Insolvency Detected');
    expect(panel).not.toContain('Legal Significance:');
  });
});
