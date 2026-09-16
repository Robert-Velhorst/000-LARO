/**
 * Phase 039 — test-data factories and fixtures.
 *
 * Deterministic builders for the core entities, shaped for direct insertion via
 * Drizzle. Defaults are chosen so a built lawyer PASSES the matching engine's
 * mandatory filters against a built case (same legal area, good standing, not
 * filtered), which lets backend tests exercise the real critical path.
 *
 * Override any field via the `over` argument.
 */
let seq = 0;
const nextId = (prefix: string) => `${prefix}_${(++seq).toString().padStart(4, '0')}`;

export function buildUser(over: Record<string, any> = {}) {
  const id = over.id ?? nextId('USER');
  const email = over.email === null
    ? null
    : String(over.email ?? `${id.toLowerCase()}@example.com`).normalize('NFKC').trim().toLowerCase();
  return {
    id,
    name: `User ${id}`,
    email,
    role: 'user',
    createdAt: new Date(),
    ...over,
    email,
  };
}

export function buildCase(over: Record<string, any> = {}) {
  const id = over.id ?? nextId('CASE');
  return {
    id,
    userId: over.userId ?? 'USER_0001',
    clientName: 'Jane Client',
    clientEmail: 'jane@example.com',
    caseType: 'Employment',
    caseSummary: 'werknemer ontslag zonder opzegtermijn door werkgever',
    urgency: 'High',
    status: 'Matching',
    legalAreas: JSON.stringify(['Employment Law']),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function buildLawyer(over: Record<string, any> = {}) {
  const id = over.id ?? nextId('LWYR');
  return {
    id,
    name: `Lawyer ${id}`,
    city: 'Amsterdam',
    legalAreas: JSON.stringify(['Employment Law']),
    email: `${id.toLowerCase()}@law.example.com`,
    phone: '+31201234567',
    // Fields the matching engine's mandatory filters check:
    barAssociationStatus: 'Good Standing',
    caseStop: 'No',
    currentlyAccepting: 'Yes',
    permanentlyFiltered: 'No',
    caseLoad: '5',
    experienceYears: '10',
    totalOutreaches: '0',
    totalResponses: '0',
    totalAcceptances: '0',
    languages: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function buildEvidence(over: Record<string, any> = {}) {
  const id = over.id ?? nextId('EVID');
  return {
    id,
    caseId: over.caseId ?? 'CASE_0001',
    userId: over.userId ?? 'USER_0001',
    type: 'document',
    source: 'manual_upload',
    title: 'Contract.pdf',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}
