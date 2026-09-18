export const SCANNER_UPLOAD_PATH = "/api/scanner-upload";

export const SCANNER_UPLOAD_HEADERS = {
  uploadId: "x-laro-upload-id",
  caseId: "x-laro-case-id",
  fileName: "x-laro-file-name",
  fileMime: "x-laro-file-mime",
  evidenceType: "x-laro-evidence-type",
  approvedSha256: "x-laro-approved-sha256",
  source: "x-laro-upload-source",
} as const;

export type ScannerUploadSource = "manual" | "desktop_scanner";
export type ScannerEvidenceType = "document" | "email" | "chat" | "photo" | "video" | "audio" | "other";

export interface ScannerUploadMetadata {
  uploadId: string;
  caseId: string;
  fileName: string;
  mimeType: string;
  evidenceType: ScannerEvidenceType;
  approvedSha256: string;
  source: ScannerUploadSource;
}

export interface ScannerUploadResult {
  id: string;
  sha256: string;
  resumed: boolean;
}
