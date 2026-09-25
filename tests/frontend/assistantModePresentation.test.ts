import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('assistant mode presentation', () => {
  it('distinguishes product help, grounded case answers, and unavailable requests', () => {
    const widget = readFileSync(join(process.cwd(), 'src/renderer/components/ChatWidget.tsx'), 'utf8');
    expect(widget).toContain('Product help mode');
    expect(widget).toContain('Source-grounded case mode');
    expect(widget).toContain('Grounded case analysis');
    expect(widget).toContain('Case selection required');
    expect(widget).toContain('Case sources unavailable');
    expect(widget).toContain('uncited legal conclusions are unavailable');
  });
});
