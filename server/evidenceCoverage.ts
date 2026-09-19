import { createHash } from 'node:crypto';
import { asc, desc, eq } from 'drizzle-orm';
import { MAX_EVIDENCE_FILE_BYTES } from '../shared/evidenceFiles';
import { getDb } from './db';
import { managedStorageKeyFromMetadata } from './managedStorage';
import {
  communications,
  documentAnalyses,
  evidence,
  evidenceFiles,
  timeline,
} from './schema';
import { storageInspect } from './storage';

export const EVIDENCE_COVERAGE_CONTRACT_VERSION = 'evidence-coverage-v1' as const;

export type CoverageInputType = 'communication' | 'timeline_event' | 'evidence_record' | 'evidence_file';
export type SourceAvailability = 'available' | 'unavailable' | 'external_unverified' | 'record_only';
export type CoverageReviewStatus = 'reviewed' | 'unreviewed';
export type CoverageAnalysisStatus = 'current' | 'not_analyzed' | 'unbound' | 'stale' | 'failed' | 'not_applicable';

export interface EvidenceCoverageInput {
  inputType: CoverageInputType;
  id: string;
  label: string;
  revision: string;
  sourceAvailability: SourceAvailability;
  reviewStatus: CoverageReviewStatus;
  analysisStatus: CoverageAnalysisStatus;
  analysisRevision: string | null;
  duplicateOf: string | null;
  contradictionFlags: number;
}

export interface CoverageUnknown {
  code: string;
  inputIds: string[];
  detail: string;
}

export interface MissingContextItem {
  id: string;
  kind: 'communication_gap' | 'potential_record_not_found';
  relatedInputIds: string[];
  detail: string;
}

export interface EvidenceCoverageAnalysis {
  contractVersion: typeof EVIDENCE_COVERAGE_CONTRACT_VERSION;
  contractStatus: 'current';
  generatedAt: string;
  sourceRevision: string;
  snapshotRevision: string;
  inputs: EvidenceCoverageInput[];
  counts: {
    inputRecords: number;
    byType: Record<CoverageInputType, number>;
    sourceAvailable: number;
    sourceUnavailable: number;
    externalSourcesUnverified: number;
    recordOnly: number;
    reviewed: number;
    unreviewed: number;
    exactDuplicateRecords: number;
    automatedContradictionFlags: number;
    missingContextItems: number;
  };
  missingContext: MissingContextItem[];
  legalBasis: {
    status: 'unknown';
    reviewedSourceIds: string[];
    detail: string;
  };
  unknowns: CoverageUnknown[];
  limitations: string[];
  reviewActions: string[];
  summary: string;
}

export interface EvidenceCoverageFindings {
  gaps: Array<{
    id: string;
    context: string;
    precedingEvents: string;
  }>;
  expectedDocuments: Array<{
    id: string;
    documentType: string;
    status: 'missing' | 'delayed' | 'incomplete' | 'received';
    reason: string;
  }>;
}

type DraftInput = EvidenceCoverageInput & {
  managedStorageKey: string | null;
  duplicateIdentity: string | null;
};

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function timestamp(value: Date | null | undefined): number | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}

function inputKey(input: Pick<EvidenceCoverageInput, 'inputType' | 'id'>): string {
  return `${input.inputType}:${input.id}`;
}

function reviewStatus(metadata: Record<string, unknown>): CoverageReviewStatus {
  return metadata.reviewStatus === 'reviewed' || metadata.reviewedAt != null
    ? 'reviewed'
    : 'unreviewed';
}

function contentIdentity(metadata: Record<string, unknown>, storageKey: string | null): string | null {
  const contentHash = typeof metadata.contentHash === 'string' && /^[a-f0-9]{32,}$/i.test(metadata.contentHash)
    ? metadata.contentHash.toLowerCase()
    : null;
  if (contentHash) return `hash:${contentHash}`;
  return storageKey ? `storage:${storageKey}` : null;
}

function parsedPrecedingEvents(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function contradictionCount(raw: string, current: boolean): number {
  if (!current) return 0;
  try {
    const parsed = JSON.parse(raw) as { contradictions?: unknown };
    return Array.isArray(parsed.contradictions) ? parsed.contradictions.length : 0;
  } catch {
    return 0;
  }
}

async function inspectManagedSources(inputs: DraftInput[]): Promise<void> {
  const managed = inputs.filter((input) => input.managedStorageKey);
  const concurrency = 8;
  for (let index = 0; index < managed.length; index += concurrency) {
    await Promise.all(managed.slice(index, index + concurrency).map(async (input) => {
      try {
        await storageInspect(input.managedStorageKey!, { maxBytes: MAX_EVIDENCE_FILE_BYTES });
        input.sourceAvailability = 'available';
      } catch {
        input.sourceAvailability = 'unavailable';
      }
    }));
  }
}

export async function buildEvidenceCoverage(
  caseId: string,
  findings: EvidenceCoverageFindings,
): Promise<EvidenceCoverageAnalysis> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const [communicationRows, timelineRows, evidenceRows, fileRows, analysisRows] = await Promise.all([
    db.select().from(communications).where(eq(communications.caseId, caseId)).orderBy(asc(communications.id)),
    db.select().from(timeline).where(eq(timeline.caseId, caseId)).orderBy(asc(timeline.id)),
    db.select().from(evidence).where(eq(evidence.caseId, caseId)).orderBy(asc(evidence.id)),
    db.select().from(evidenceFiles).where(eq(evidenceFiles.caseId, caseId)).orderBy(asc(evidenceFiles.id)),
    db.select().from(documentAnalyses).where(eq(documentAnalyses.caseId, caseId))
      .orderBy(desc(documentAnalyses.updatedAt), desc(documentAnalyses.id)),
  ]);

  const latestAnalysis = new Map<string, typeof analysisRows[number]>();
  for (const analysis of analysisRows) {
    if (!latestAnalysis.has(analysis.evidenceId)) latestAnalysis.set(analysis.evidenceId, analysis);
  }

  const inputs: DraftInput[] = [];

  for (const row of communicationRows) {
    const metadata = parseObject(row.metadata);
    const storageKey = managedStorageKeyFromMetadata(row.metadata);
    inputs.push({
      inputType: 'communication',
      id: row.id,
      label: row.subject || row.channel || 'Communication record',
      revision: digest([
        'communication', row.id, row.channel, row.type, row.direction, row.subject,
        row.body, row.content, row.metadata, timestamp(row.timestamp), timestamp(row.createdAt),
      ]),
      sourceAvailability: storageKey ? 'unavailable' : 'record_only',
      reviewStatus: reviewStatus(metadata),
      analysisStatus: 'not_applicable',
      analysisRevision: null,
      duplicateOf: null,
      contradictionFlags: 0,
      managedStorageKey: storageKey,
      duplicateIdentity: contentIdentity(metadata, storageKey),
    });
  }

  for (const row of timelineRows) {
    const metadata = parseObject(row.metadata);
    const storageKey = managedStorageKeyFromMetadata(row.metadata);
    inputs.push({
      inputType: 'timeline_event',
      id: row.id,
      label: row.title || row.eventType || 'Timeline event',
      revision: digest([
        'timeline_event', row.id, row.eventType, row.title, row.description,
        row.metadata, timestamp(row.eventAt), timestamp(row.createdAt),
      ]),
      sourceAvailability: storageKey ? 'unavailable' : 'record_only',
      reviewStatus: reviewStatus(metadata),
      analysisStatus: 'not_applicable',
      analysisRevision: null,
      duplicateOf: null,
      contradictionFlags: 0,
      managedStorageKey: storageKey,
      duplicateIdentity: contentIdentity(metadata, storageKey),
    });
  }

  for (const row of evidenceRows) {
    const metadata = parseObject(row.metadata);
    const storageKey = managedStorageKeyFromMetadata(row.metadata);
    const analysis = latestAnalysis.get(row.id);
    const metadataHash = typeof metadata.contentHash === 'string' && /^[a-f0-9]{32,}$/i.test(metadata.contentHash)
      ? metadata.contentHash.toLowerCase()
      : null;
    const analysisCurrent = !!analysis
      && metadataHash !== null
      && metadataHash === analysis.contentHash.toLowerCase();
    const analysisRevision = analysis
      ? digest([
        analysis.id, analysis.analysisVersion, analysis.contentHash, analysis.status,
        analysis.result, timestamp(analysis.updatedAt),
      ])
      : null;
    inputs.push({
      inputType: 'evidence_record',
      id: row.id,
      label: row.title || row.fileName || 'Evidence record',
      revision: digest([
        'evidence_record', row.id, row.type, row.source, row.title, row.description,
        row.fileUrl, row.fileName, row.fileSize, row.mimeType, row.metadata,
        row.tags, row.relevant, timestamp(row.createdAt), timestamp(row.updatedAt),
      ]),
      sourceAvailability: storageKey
        ? 'unavailable'
        : row.fileUrl ? 'external_unverified' : 'record_only',
      reviewStatus: reviewStatus(metadata),
      analysisStatus: !analysis
        ? 'not_analyzed'
        : !metadataHash ? 'unbound'
          : !analysisCurrent ? 'stale'
          : analysis.status === 'complete' ? 'current' : 'failed',
      analysisRevision,
      duplicateOf: null,
      contradictionFlags: analysis ? contradictionCount(analysis.result, analysisCurrent) : 0,
      managedStorageKey: storageKey,
      duplicateIdentity: contentIdentity(metadata, storageKey)
        || (analysisCurrent ? `hash:${analysis!.contentHash.toLowerCase()}` : null),
    });
  }

  for (const row of fileRows) {
    const storageKey = row.storageKey?.trim() || null;
    inputs.push({
      inputType: 'evidence_file',
      id: row.id,
      label: row.fileName || 'Evidence file',
      revision: digest([
        'evidence_file', row.id, row.fileType, row.fileSize, row.uploadSource,
        row.fileName, row.mimeType, row.storageKey, timestamp(row.uploadedAt),
      ]),
      sourceAvailability: 'unavailable',
      reviewStatus: 'unreviewed',
      analysisStatus: 'not_analyzed',
      analysisRevision: null,
      duplicateOf: null,
      contradictionFlags: 0,
      managedStorageKey: storageKey,
      duplicateIdentity: storageKey ? `storage:${storageKey}` : null,
    });
  }

  inputs.sort((left, right) => inputKey(left).localeCompare(inputKey(right)));
  await inspectManagedSources(inputs);

  const firstByIdentity = new Map<string, string>();
  for (const input of inputs) {
    if (!input.duplicateIdentity) continue;
    const first = firstByIdentity.get(input.duplicateIdentity);
    if (first) input.duplicateOf = first;
    else firstByIdentity.set(input.duplicateIdentity, inputKey(input));
  }

  const publicInputs: EvidenceCoverageInput[] = inputs.map(({
    managedStorageKey: _managedStorageKey,
    duplicateIdentity: _duplicateIdentity,
    ...input
  }) => input);
  const sourceRevision = digest(publicInputs.map((input) => ({
    inputType: input.inputType,
    id: input.id,
    revision: input.revision,
    analysisRevision: input.analysisRevision,
  })));
  const snapshotRevision = digest(publicInputs.map((input) => ({
    inputType: input.inputType,
    id: input.id,
    revision: input.revision,
    analysisRevision: input.analysisRevision,
    sourceAvailability: input.sourceAvailability,
    reviewStatus: input.reviewStatus,
    duplicateOf: input.duplicateOf,
    contradictionFlags: input.contradictionFlags,
  })));
  const canonicalInputIds = new Map(publicInputs.map((input) => [input.id, inputKey(input)]));

  const missingContext: MissingContextItem[] = [
    ...findings.gaps.map((gap) => ({
      id: gap.id,
      kind: 'communication_gap' as const,
      relatedInputIds: parsedPrecedingEvents(gap.precedingEvents)
        .map((id) => canonicalInputIds.get(id) ?? id),
      detail: gap.context,
    })),
    ...findings.expectedDocuments
      .filter((document) => document.status === 'missing' || document.status === 'delayed')
      .map((document) => ({
        id: document.id,
        kind: 'potential_record_not_found' as const,
        relatedInputIds: [],
        detail: `${document.documentType}: ${document.reason}`,
      })),
  ];

  const byType: Record<CoverageInputType, number> = {
    communication: 0,
    timeline_event: 0,
    evidence_record: 0,
    evidence_file: 0,
  };
  for (const input of publicInputs) byType[input.inputType] += 1;

  const inputIds = (predicate: (input: EvidenceCoverageInput) => boolean) =>
    publicInputs.filter(predicate).map(inputKey);
  const unreviewedIds = inputIds((input) => input.reviewStatus === 'unreviewed');
  const unavailableIds = inputIds((input) => input.sourceAvailability === 'unavailable');
  const externalIds = inputIds((input) => input.sourceAvailability === 'external_unverified');
  const duplicateIds = inputIds((input) => input.duplicateOf !== null);
  const contradictionIds = inputIds((input) => input.contradictionFlags > 0);
  const unboundAnalysisIds = inputIds((input) => input.analysisStatus === 'unbound');
  const staleAnalysisIds = inputIds((input) => input.analysisStatus === 'stale');

  const unknowns: CoverageUnknown[] = [{
    code: 'legal_basis_unknown',
    inputIds: [],
    detail: 'No reviewed legal-basis source is bound to this coverage snapshot.',
  }];
  if (publicInputs.length === 0) unknowns.push({
    code: 'no_inputs',
    inputIds: [],
    detail: 'LARO has no case records to inventory for this snapshot.',
  });
  if (unreviewedIds.length > 0) unknowns.push({
    code: 'unreviewed_records',
    inputIds: unreviewedIds,
    detail: 'These records have no explicit human-review marker.',
  });
  if (unavailableIds.length > 0) unknowns.push({
    code: 'source_unavailable',
    inputIds: unavailableIds,
    detail: 'The managed source could not be inspected or no managed source is attached.',
  });
  if (externalIds.length > 0) unknowns.push({
    code: 'external_source_unverified',
    inputIds: externalIds,
    detail: 'External references were inventoried but not fetched or verified.',
  });
  if (duplicateIds.length > 0) unknowns.push({
    code: 'exact_duplicates',
    inputIds: duplicateIds,
    detail: 'These records share an exact content hash or managed-storage identity with an earlier input.',
  });
  if (contradictionIds.length > 0) unknowns.push({
    code: 'automated_contradiction_flags',
    inputIds: contradictionIds,
    detail: 'Automated analysis flagged potentially inconsistent statements; a person must review the cited source passages.',
  });
  if (unboundAnalysisIds.length > 0) unknowns.push({
    code: 'analysis_revision_unbound',
    inputIds: unboundAnalysisIds,
    detail: 'A saved analysis exists, but the record has no current source hash to prove that the analysis matches it.',
  });
  if (staleAnalysisIds.length > 0) unknowns.push({
    code: 'stale_analysis',
    inputIds: staleAnalysisIds,
    detail: 'The saved analysis revision does not match the current source hash.',
  });
  if (missingContext.length > 0) unknowns.push({
    code: 'missing_context',
    inputIds: missingContext.flatMap((item) => item.relatedInputIds),
    detail: `${missingContext.length} communication or potentially relevant-record item(s) require verification.`,
  });

  const counts = {
    inputRecords: publicInputs.length,
    byType,
    sourceAvailable: publicInputs.filter((input) => input.sourceAvailability === 'available').length,
    sourceUnavailable: unavailableIds.length,
    externalSourcesUnverified: externalIds.length,
    recordOnly: publicInputs.filter((input) => input.sourceAvailability === 'record_only').length,
    reviewed: publicInputs.filter((input) => input.reviewStatus === 'reviewed').length,
    unreviewed: unreviewedIds.length,
    exactDuplicateRecords: duplicateIds.length,
    automatedContradictionFlags: publicInputs.reduce((total, input) => total + input.contradictionFlags, 0),
    missingContextItems: missingContext.length,
  };
  const reviewActions = [
    ...(unavailableIds.length > 0 ? ['Restore or relink unavailable managed sources before relying on their metadata.'] : []),
    ...(externalIds.length > 0 ? ['Open and verify external references; LARO did not fetch them for this snapshot.'] : []),
    ...(unreviewedIds.length > 0 ? ['Review the listed records and record an explicit review marker where appropriate.'] : []),
    ...(duplicateIds.length > 0 ? ['Review exact duplicates once and retain the record with the clearest provenance.'] : []),
    ...(contradictionIds.length > 0 ? ['Review every automated contradiction flag against its cited source passages.'] : []),
    ...(missingContext.length > 0 ? ['Check the listed missing-context items against records inside and outside LARO.'] : []),
    'Ask a qualified lawyer to identify and review the applicable legal-basis sources.',
  ];

  return {
    contractVersion: EVIDENCE_COVERAGE_CONTRACT_VERSION,
    contractStatus: 'current',
    generatedAt: new Date().toISOString(),
    sourceRevision,
    snapshotRevision,
    inputs: publicInputs,
    counts,
    missingContext,
    legalBasis: {
      status: 'unknown',
      reviewedSourceIds: [],
      detail: 'No reviewed legal-basis source is bound to this coverage snapshot.',
    },
    unknowns,
    limitations: [
      'This snapshot inventories only records currently visible to LARO; records held elsewhere remain unknown.',
      'Record counts, source availability, duplicate signals, and context gaps do not establish claim support, legal merit, liability, or likely outcome.',
      'Automated contradiction flags and missing-context signals require human review against the original sources.',
      'External references are not treated as available unless their contents are imported and revision-bound.',
    ],
    reviewActions,
    summary: `Inventoried ${counts.inputRecords} input record(s): ${counts.sourceAvailable} managed source(s) available, ${counts.sourceUnavailable} unavailable, ${counts.externalSourcesUnverified} external reference(s) unverified, and ${counts.unreviewed} record(s) without an explicit review marker.`,
  };
}
