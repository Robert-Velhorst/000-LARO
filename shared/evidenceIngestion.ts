import { MAX_EVIDENCE_FILE_BYTES } from "./evidenceFiles";

/**
 * One resource contract for every maintained evidence-ingestion workflow.
 * Provider-specific discovery limits may be lower, but may never exceed these
 * byte/item/concurrency ceilings once an object is selected for ingestion.
 */
export interface EvidenceIngestionLimitValues {
  maxFileBytes: number;
  maxJobBytes: number;
  maxJobItems: number;
  maxConcurrentOperations: number;
  maxAnalysisItems: number;
  minLocalStorageHeadroomBytes: number;
}

export const EVIDENCE_INGESTION_LIMITS = {
  maxFileBytes: MAX_EVIDENCE_FILE_BYTES,
  maxJobBytes: 64 * 1024 * 1024,
  maxJobItems: 50,
  maxConcurrentOperations: 2,
  maxAnalysisItems: 20,
  minLocalStorageHeadroomBytes: 256 * 1024 * 1024,
} as const satisfies EvidenceIngestionLimitValues;

export const EVIDENCE_INGESTION_SOURCES = [
  "collection",
  "local",
  "google_drive",
  "gmail_attachment",
  "gmail_message",
  "manual",
  "document_inbox",
  "desktop_scanner",
] as const;

export type EvidenceIngestionSource = typeof EVIDENCE_INGESTION_SOURCES[number];

export type EvidenceIngestionReasonCode =
  | "cancelled"
  | "concurrency_limit"
  | "duplicate"
  | "file_empty"
  | "file_too_large"
  | "job_byte_limit"
  | "job_item_limit"
  | "analysis_limit"
  | "storage_headroom"
  | "source_changed"
  | "read_failed"
  | "store_failed";

export interface EvidenceIngestionReason {
  source: EvidenceIngestionSource;
  code: EvidenceIngestionReasonCode;
  count: number;
}

export interface EvidenceIngestionSummary {
  outcome: "completed" | "partial" | "cancelled";
  processedItems: number;
  skippedItems: number;
  processedBytes: number;
  admittedBytes: number;
  analysisItems: number;
  limits: EvidenceIngestionLimitValues;
  reasons: EvidenceIngestionReason[];
}

export function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
