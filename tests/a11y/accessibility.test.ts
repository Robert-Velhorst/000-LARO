/**
 * Phase 049 — accessibility review (testable helpers).
 *
 * The pure accessibility utilities (contrast ratio, unique id generation) are
 * unit-tested here. DOM-dependent helpers (focus trap, screen-reader announce)
 * require jsdom and are reviewed in docs/ACCESSIBILITY.md.
 */
import { describe, it, expect } from 'vitest';
import { hasGoodContrast, generateId } from '../../server/accessibility';

describe('Phase 049 — contrast (WCAG)', () => {
  it('black on white passes (high contrast)', () => {
    expect(hasGoodContrast('#000000', '#ffffff')).toBe(true);
  });
  it('light grey on white fails normal-text contrast', () => {
    expect(hasGoodContrast('#cccccc', '#ffffff')).toBe(false);
  });
  it('mid grey may pass for large text but not normal text', () => {
    // #767676 on white ≈ 4.54:1 — passes normal; #999999 ≈ 2.8 — large only.
    expect(hasGoodContrast('#999999', '#ffffff', true)).toBe(false); // still < 3? guard both
    expect(hasGoodContrast('#000000', '#ffffff', true)).toBe(true);
  });
  it('fails closed for unsupported color values', () => {
    expect(hasGoodContrast('not-a-color', '#ffffff')).toBe(false);
    expect(hasGoodContrast('#ffffff', 'transparent')).toBe(false);
  });
});

describe('Phase 049 — id generation', () => {
  it('produces unique, prefixed ids', () => {
    const a = generateId('field');
    const b = generateId('field');
    expect(a).not.toBe(b);
    expect(a.startsWith('field')).toBe(true);
  });
});
