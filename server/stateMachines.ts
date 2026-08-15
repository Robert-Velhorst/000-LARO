/**
 * Phase 059 — formal state machines.
 *
 * Case status and outreach status were previously free-form strings set
 * ad-hoc across the codebase. This module defines the *allowed* transitions and
 * a guard (`assertTransition`) so the workflow can't move a case/outreach into
 * an invalid state. It is enforced in cases.update and the outreach approval gate.
 */
import { TRPCError } from "@trpc/server";

// ── Case lifecycle ──────────────────────────────────────────────────────────
export const CASE_STATES = ["Intake", "Matching", "Outreach", "Matched", "Closed"] as const;
export type CaseState = (typeof CASE_STATES)[number];

const CASE_TRANSITIONS: Record<CaseState, CaseState[]> = {
  Intake: ["Matching", "Closed"],
  Matching: ["Outreach", "Matched", "Closed"],
  Outreach: ["Matched", "Closed", "Matching"], // may return to Matching to re-match
  Matched: ["Closed", "Outreach"],
  Closed: [], // terminal
};

// ── Outreach lifecycle ──────────────────────────────────────────────────────
export const OUTREACH_STATES = [
  "PendingApproval",
  "Approved",
  "Dispatching",
  "Rejected",
  "Sent",
  "Interested",
  "Declined",
  "NoResponse",
] as const;
export type OutreachState = (typeof OUTREACH_STATES)[number];

const OUTREACH_TRANSITIONS: Record<OutreachState, OutreachState[]> = {
  PendingApproval: ["Approved", "Rejected"],
  Approved: ["Dispatching", "Rejected"], // may still be pulled before dispatch is claimed
  Dispatching: ["Sent", "Approved"], // Approved is recovery after confirmed non-delivery
  Rejected: [], // terminal
  Sent: ["Interested", "Declined", "NoResponse"],
  Interested: ["Declined", "NoResponse"],
  Declined: [],
  NoResponse: ["Interested", "Declined"],
};

function canTransitionIn<T extends string>(
  table: Record<T, T[]>,
  from: T | null | undefined,
  to: T
): boolean {
  // Allow setting an initial state when there is no prior state.
  if (from == null) return true;
  if (from === to) return true; // idempotent no-op
  const allowed = table[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function isValidCaseState(s: string): s is CaseState {
  return (CASE_STATES as readonly string[]).includes(s);
}
export function isValidOutreachState(s: string): s is OutreachState {
  return (OUTREACH_STATES as readonly string[]).includes(s);
}

export function canTransitionCase(from: string | null | undefined, to: string): boolean {
  if (!isValidCaseState(to)) return false;
  return canTransitionIn(CASE_TRANSITIONS, (from ?? null) as CaseState | null, to);
}

export function canTransitionOutreach(from: string | null | undefined, to: string): boolean {
  if (!isValidOutreachState(to)) return false;
  return canTransitionIn(OUTREACH_TRANSITIONS, (from ?? null) as OutreachState | null, to);
}

/** Throw a typed error if a case-status transition is not allowed. */
export function assertCaseTransition(from: string | null | undefined, to: string): void {
  if (!isValidCaseState(to)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid case status "${to}". Allowed: ${CASE_STATES.join(", ")}` });
  }
  if (!canTransitionCase(from, to)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Illegal case transition ${from ?? "∅"} → ${to}` });
  }
}

/** Throw a typed error if an outreach-status transition is not allowed. */
export function assertOutreachTransition(from: string | null | undefined, to: string): void {
  if (!isValidOutreachState(to)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid outreach status "${to}"` });
  }
  if (!canTransitionOutreach(from, to)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Illegal outreach transition ${from ?? "∅"} → ${to}` });
  }
}
