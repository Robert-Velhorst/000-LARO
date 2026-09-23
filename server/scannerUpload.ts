import { createHash, randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AUDIT_ACTIONS, createAuditLog } from "./audit";
import { assertCaseOwnership } from "./_core/authz";
import { createContext, type TrpcContext } from "./context";
import { getDb } from "./db";
import { createEvidenceFile } from "./evidence";
import { evidence } from "./schema";
import { hashBuffer, sanitizeFilename, storageDelete, storagePut } from "./storage";
import {
  isSupportedEvidenceMimeType,
  MAX_EVIDENCE_FILE_BYTES,
} from "../shared/evidenceFiles";
import {
  SCANNER_UPLOAD_HEADERS,
  SCANNER_UPLOAD_PATH,
  type ScannerUploadMetadata,
  type ScannerUploadResult,
} from "../shared/scannerUpload";
import {
  acquireEvidenceIngestionRequestOperation,
  admitEvidenceIngestionRequest,
  EvidenceIngestionLimitError,
} from "./evidenceIngestionBudget";

const metadataSchema = z.object({
  uploadId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  jobId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  caseId: z.string().min(1).max(200),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  evidenceType: z.enum(["document", "email", "chat", "photo", "video", "audio", "other"]),
  approvedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.enum(["manual", "desktop_scanner"]),
});

type PreparedScannerRequest = Request & {
  scannerUpload?: {
    ctx: TrpcContext & { user: NonNullable<TrpcContext["user"]> };
    metadata: ScannerUploadMetadata;
    ingestion: Awaited<ReturnType<typeof admitEvidenceIngestionRequest>>;
    releaseIngestion: () => void;
  };
};

export class ScannerUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ScannerUploadError";
  }
}

function header(req: Request, name: string): string {
  return req.get(name)?.trim() || "";
}

function readMetadata(req: Request): ScannerUploadMetadata {
  let fileName = "";
  try {
    fileName = decodeURIComponent(header(req, SCANNER_UPLOAD_HEADERS.fileName));
  } catch {
    throw new ScannerUploadError("The scanner filename header is malformed.", 400, "INVALID_METADATA");
  }
  const parsed = metadataSchema.safeParse({
    uploadId: header(req, SCANNER_UPLOAD_HEADERS.uploadId),
    jobId: header(req, SCANNER_UPLOAD_HEADERS.jobId) || undefined,
    caseId: header(req, SCANNER_UPLOAD_HEADERS.caseId),
    fileName,
    mimeType: header(req, SCANNER_UPLOAD_HEADERS.fileMime).toLowerCase(),
    evidenceType: header(req, SCANNER_UPLOAD_HEADERS.evidenceType),
    approvedSha256: header(req, SCANNER_UPLOAD_HEADERS.approvedSha256).toLowerCase(),
    source: header(req, SCANNER_UPLOAD_HEADERS.source),
  });
  if (!parsed.success) {
    throw new ScannerUploadError("The scanner upload metadata is invalid.", 400, "INVALID_METADATA");
  }
  if (!isSupportedEvidenceMimeType(parsed.data.mimeType)) {
    throw new ScannerUploadError("Evidence file type is not supported.", 415, "UNSUPPORTED_FILE_TYPE");
  }
  return parsed.data;
}

function evidenceIdForUpload(userId: string, metadata: ScannerUploadMetadata): string {
  const digest = createHash("sha256")
    .update(`${userId}\0${metadata.caseId}\0${metadata.uploadId}`)
    .digest("hex");
  return `SCAN-${digest}`;
}

function parseEvidenceMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function existingUpload(
  userId: string,
  evidenceId: string,
  metadata: ScannerUploadMetadata,
  byteLength: number,
): Promise<ScannerUploadResult | null> {
  const db = await getDb();
  if (!db) throw new ScannerUploadError("Evidence storage is unavailable.", 503, "STORAGE_UNAVAILABLE");
  const [row] = await db.select().from(evidence).where(and(
    eq(evidence.id, evidenceId),
    eq(evidence.userId, userId),
    eq(evidence.caseId, metadata.caseId),
  )).limit(1);
  if (!row) return null;
  const storedMetadata = parseEvidenceMetadata(row.metadata);
  if (
    storedMetadata.scannerUploadId !== metadata.uploadId ||
    storedMetadata.approvedContentHash !== metadata.approvedSha256 ||
    storedMetadata.contentHash !== metadata.approvedSha256 ||
    storedMetadata.scannerUploadFileName !== metadata.fileName ||
    row.fileSize !== byteLength ||
    row.mimeType !== metadata.mimeType ||
    row.type !== metadata.evidenceType ||
    row.source !== metadata.source
  ) {
    throw new ScannerUploadError(
      "This scanner upload identifier is already bound to different evidence.",
      409,
      "UPLOAD_ID_CONFLICT",
    );
  }
  return { id: row.id, sha256: metadata.approvedSha256, resumed: true };
}

export async function persistScannerUpload(
  userId: string,
  metadata: ScannerUploadMetadata,
  bytes: Buffer,
): Promise<ScannerUploadResult> {
  if (!bytes.length || bytes.length > MAX_EVIDENCE_FILE_BYTES) {
    throw new ScannerUploadError("Evidence uploads must be between 1 byte and 7 MB.", 413, "PAYLOAD_TOO_LARGE");
  }
  const calculatedHash = hashBuffer(bytes);
  if (calculatedHash !== metadata.approvedSha256) {
    throw new ScannerUploadError(
      "Uploaded bytes do not match the approved file digest.",
      409,
      "APPROVED_DIGEST_MISMATCH",
    );
  }

  const evidenceId = evidenceIdForUpload(userId, metadata);
  const previous = await existingUpload(userId, evidenceId, metadata, bytes.length);
  if (previous) return previous;

  const fileName = sanitizeFilename(metadata.fileName);
  // Concurrent retries must never overwrite the winning request's bytes.
  const storageKey = `evidence/${metadata.caseId}/scanner/${evidenceId}-${randomUUID()}-${fileName}`;
  const stored = await storagePut(storageKey, bytes, metadata.mimeType);
  try {
    await createEvidenceFile(userId, {
      id: evidenceId,
      caseId: metadata.caseId,
      title: fileName,
      type: metadata.evidenceType,
      source: metadata.source,
      fileName,
      fileSize: bytes.length,
      mimeType: metadata.mimeType,
      fileUrl: stored.url,
      contentHash: stored.sha256,
      metadata: JSON.stringify({
        storageKey: stored.key,
        scannerUploadId: metadata.uploadId,
        scannerUploadFileName: metadata.fileName,
        approvedContentHash: metadata.approvedSha256,
      }),
    });
  } catch (error) {
    // A response can be interrupted after another identical request commits.
    // Each attempt has its own object, so only this attempt's orphan is removed.
    let raced: ScannerUploadResult | null = null;
    let conflict: ScannerUploadError | null = null;
    try {
      raced = await existingUpload(userId, evidenceId, metadata, bytes.length);
    } catch (lookupError) {
      if (lookupError instanceof ScannerUploadError) conflict = lookupError;
    }
    await storageDelete(stored.key).catch(() => undefined);
    if (conflict) throw conflict;
    if (raced) return raced;
    throw error;
  }

  await createAuditLog({
    userId,
    action: AUDIT_ACTIONS.EVIDENCE_SCANNER_UPLOADED,
    entityType: "evidence",
    entityId: evidenceId,
    details: {
      caseId: metadata.caseId,
      scannerUploadId: metadata.uploadId,
      approvedContentHash: metadata.approvedSha256,
      storedContentHash: stored.sha256,
    },
  });
  return { id: evidenceId, sha256: stored.sha256, resumed: false };
}

async function prepareRequest(req: PreparedScannerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.is("application/octet-stream")) {
      throw new ScannerUploadError("Scanner uploads require an application/octet-stream body.", 415, "INVALID_CONTENT_TYPE");
    }
    const metadata = readMetadata(req);
    const ctx = await createContext({ req, res });
    if (!ctx.user || ctx.authScope !== "session") {
      throw new ScannerUploadError("Authentication is required.", 401, "AUTHENTICATION_REQUIRED");
    }
    const scannerCredential = ctx.desktopScanner;
    if (scannerCredential !== (metadata.source === "desktop_scanner")) {
      throw new ScannerUploadError(
        scannerCredential
          ? "Scanner uploads must identify the desktop scanner source."
          : "Desktop scanner provenance requires the active local scanner credential.",
        403,
        "SCANNER_CREDENTIAL_REQUIRED",
      );
    }
    const contentLength = req.get("content-length");
    if (!contentLength) {
      throw new ScannerUploadError("Scanner uploads require a declared content length.", 411, "CONTENT_LENGTH_REQUIRED");
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1) {
      throw new ScannerUploadError("The scanner upload length is invalid.", 400, "INVALID_CONTENT_LENGTH");
    }
    if (declaredBytes > MAX_EVIDENCE_FILE_BYTES) {
      throw new ScannerUploadError("Evidence uploads must be between 1 byte and 7 MB.", 413, "PAYLOAD_TOO_LARGE");
    }
    await assertCaseOwnership(metadata.caseId, ctx.user.id);
    let ingestion: Awaited<ReturnType<typeof admitEvidenceIngestionRequest>>;
    let releaseIngestion: () => void;
    try {
      ingestion = await admitEvidenceIngestionRequest({
        ownerId: ctx.user.id,
        jobId: metadata.jobId ?? metadata.uploadId,
        itemId: metadata.uploadId,
        source: metadata.source === "desktop_scanner" ? "desktop_scanner" : "manual",
        bytes: declaredBytes,
      });
      releaseIngestion = acquireEvidenceIngestionRequestOperation({
        ownerId: ctx.user.id,
        jobId: metadata.jobId ?? metadata.uploadId,
        source: metadata.source === "desktop_scanner" ? "desktop_scanner" : "manual",
      });
    } catch (error) {
      if (error instanceof EvidenceIngestionLimitError) {
        throw new ScannerUploadError(
          error.message,
          error.code === "file_empty" || error.code === "file_too_large" ? 413
            : error.code === "source_changed" ? 409 : 429,
          error.code === "source_changed" ? "UPLOAD_ID_CONFLICT" : error.code.toUpperCase(),
        );
      }
      throw error;
    }
    req.scannerUpload = { ctx: { ...ctx, user: ctx.user }, metadata, ingestion, releaseIngestion };
    next();
  } catch (error) {
    sendUploadError(res, error);
  }
}

function sendUploadError(res: Response, error: unknown): void {
  if (res.headersSent) return;
  if (error instanceof ScannerUploadError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof TRPCError) {
    const status = error.code === "UNAUTHORIZED" ? 401 : error.code === "FORBIDDEN" ? 403 :
      error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  const entityTooLarge = Boolean(error && typeof error === "object" && (error as { type?: string }).type === "entity.too.large");
  if (entityTooLarge) {
    res.status(413).json({ error: "Evidence uploads must be between 1 byte and 7 MB.", code: "PAYLOAD_TOO_LARGE" });
    return;
  }
  console.error("[ScannerUpload] Upload failed", {
    error: error instanceof Error ? error.message : "unknown scanner upload failure",
  });
  res.status(500).json({ error: "The scanner upload could not be completed.", code: "UPLOAD_FAILED" });
}

export const scannerUploadRouter = express.Router();

scannerUploadRouter.post(
  SCANNER_UPLOAD_PATH,
  (req, res, next) => { void prepareRequest(req as PreparedScannerRequest, res, next); },
  express.raw({ type: "application/octet-stream", limit: MAX_EVIDENCE_FILE_BYTES }),
  async (req: PreparedScannerRequest, res: Response) => {
    try {
      if (!req.scannerUpload || !Buffer.isBuffer(req.body)) {
        throw new ScannerUploadError("The scanner upload body is invalid.", 400, "INVALID_BODY");
      }
      const result = await persistScannerUpload(
        req.scannerUpload.ctx.user.id,
        req.scannerUpload.metadata,
        req.body,
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(result.resumed ? 200 : 201).json({
        ...result,
        ingestion: {
          outcome: "completed",
          processedItems: req.scannerUpload.ingestion.items,
          processedBytes: req.scannerUpload.ingestion.bytes,
        },
      });
    } catch (error) {
      sendUploadError(res, error);
    } finally {
      req.scannerUpload?.releaseIngestion();
    }
  },
);

scannerUploadRouter.use((error: unknown, req: PreparedScannerRequest, res: Response, _next: NextFunction) => {
  req.scannerUpload?.releaseIngestion();
  sendUploadError(res, error);
});
