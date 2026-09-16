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

    expect(panel).toContain('Registry source');
    expect(panel).toContain('Source field:');
    expect(panel).toContain('Review-only triage');
    expect(panel).toContain('These prompts are not registry facts or legal findings.');
    expect(panel).toContain('Dataset limitations');
    expect(panel).not.toContain('Insolvency Detected');
    expect(panel).not.toContain('Legal Significance:');
  });
});
