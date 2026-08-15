/**
 * Phase 059 — formal state machine unit tests (pure).
 */
import { describe, it, expect } from 'vitest';
import {
  canTransitionCase, canTransitionOutreach,
  assertCaseTransition, assertOutreachTransition,
} from '../../server/stateMachines';

describe('Phase 059 — case state machine', () => {
  it('allows Matching -> Outreach and Outreach -> Matched', () => {
    expect(canTransitionCase('Matching', 'Outreach')).toBe(true);
    expect(canTransitionCase('Outreach', 'Matched')).toBe(true);
  });
  it('forbids Closed -> anything (terminal)', () => {
    expect(canTransitionCase('Closed', 'Matching')).toBe(false);
    expect(() => assertCaseTransition('Closed', 'Outreach')).toThrow();
  });
  it('rejects unknown target states', () => {
    expect(canTransitionCase('Matching', 'Bananas')).toBe(false);
    expect(() => assertCaseTransition('Matching', 'Bananas')).toThrow();
  });
  it('allows setting an initial state from null', () => {
    expect(canTransitionCase(null, 'Matching')).toBe(true);
  });
});

describe('Phase 059 — outreach state machine', () => {
  it('allows PendingApproval -> Approved/Rejected', () => {
    expect(canTransitionOutreach('PendingApproval', 'Approved')).toBe(true);
    expect(canTransitionOutreach('PendingApproval', 'Rejected')).toBe(true);
  });
  it('forbids PendingApproval -> Sent (must be approved first)', () => {
    expect(canTransitionOutreach('PendingApproval', 'Sent')).toBe(false);
    expect(() => assertOutreachTransition('PendingApproval', 'Sent')).toThrow();
  });
  it('requires a dispatch claim before an approved message can be sent', () => {
    expect(canTransitionOutreach('Approved', 'Dispatching')).toBe(true);
    expect(canTransitionOutreach('Approved', 'Sent')).toBe(false);
    expect(canTransitionOutreach('Dispatching', 'Sent')).toBe(true);
    expect(canTransitionOutreach('Dispatching', 'Approved')).toBe(true);
  });
});
