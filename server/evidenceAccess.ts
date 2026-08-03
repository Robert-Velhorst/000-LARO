import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { ENV } from "./_core/env";
import { AUDIT_ACTIONS, createAuditLog } from "./audit";
import { getDb } from "./db";
import { getEvidenceFile } from "./evidence";
import { managedStorageKeyFromMetadata } from "./managedStorage";
import { evidence } from "./schema";
import { hashBuffer, storageGet, storageRead } from "./storage";

const DOWNLOAD_TTL_SECONDS = 300;
const MAX_CLOCK_WINDOW_SECONDS = 600;
const SAFE_MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export class EvidenceAccessError extends Error {
  constructor(message: string, readonly status: 401 | 404 | 409 = 401) {
    super(message);
    this.name = "EvidenceAccessError";
  }
}

function signaturePayload(evidenceId: string, expiresAt: number): string {
  return `${evidenceId}\n${expiresAt}`;
}

function signEvidenceAccess(evidenceId: string, expiresAt: number): string {
  return createHmac("sha256", ENV.JWT_SECRET)
    .update(signaturePayload(evidenceId, expiresAt))
    .digest("hex");
}

function validSignature(evidenceId: string, expiresAt: number, signature: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signEvidenceAccess(evidenceId, expiresAt), "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function safeMimeType(value: string | null): string {
  const normalized = (value || "").toLowerCase().split(";", 1)[0].trim();
  return SAFE_MIME_TYPE.test(normalized) ? normalized : "application/octet-stream";
}

function publicApiBase(explicitBaseUrl?: string): URL {
  const localBaseUrl = `http://localhost:${Number(process.env.PORT) || 3000}`;
  const raw = (
    (ENV.SERVER_ONLY ? process.env.OAUTH_REDIRECT_BASE_URL : explicitBaseUrl) ||
    localBaseUrl
  ).trim();
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("OAUTH_REDIRECT_BASE_URL must be a plain HTTP(S) base URL");
  }
  if (
    !ENV.SERVER_ONLY &&
    (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()))
  ) {
    throw new Error("Desktop evidence links must use a loopback HTTP origin");
  }
  return url;
}

function signedLocalDownloadUrl(evidenceId: string, now: Date, baseUrl?: string): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + DOWNLOAD_TTL_SECONDS;
  const url = publicApiBase(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/evidence-content/${encodeURIComponent(evidenceId)}`;
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("signature", signEvidenceAccess(evidenceId, expiresAt));
  return url.toString();
}

export async function getEvidenceDownloadUrl(
  userId: string,
  evidenceId: string,
  now = new Date(),
  baseUrl?: string,
): Promise<string | null> {
  const file = await getEvidenceFile(userId, evidenceId);
  if (!file) throw new EvidenceAccessError("File not found", 404);

  const storageKey = managedStorageKeyFromMetadata(file.metadata);
  if (storageKey) {
    const storageUrl = await storageGet(storageKey);
    return storageUrl.startsWith("file://")
      ? signedLocalDownloadUrl(file.id, now, baseUrl)
      : storageUrl;
  }
  return file.fileUrl || null;
}

export async function readSignedEvidenceDownload(options: {
  evidenceId: string;
  expires: string | undefined;
  signature: string | undefined;
  now?: Date;
}) {
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const expiresAt = Number(options.expires);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < nowSeconds ||
    expiresAt > nowSeconds + MAX_CLOCK_WINDOW_SECONDS ||
    !options.signature ||
    !validSignature(options.evidenceId, expiresAt, options.signature)
  ) {
    throw new EvidenceAccessError("Evidence link is invalid or expired");
  }

  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [file] = await db.select().from(evidence).where(eq(evidence.id, options.evidenceId)).limit(1);
  if (!file) throw new EvidenceAccessError("File not found", 404);
  const storageKey = managedStorageKeyFromMetadata(file.metadata);
  if (!storageKey) throw new EvidenceAccessError("Managed source file is unavailable", 404);

  const bytes = await storageRead(storageKey);
  let expectedHash: string | null = null;
  try {
    const metadata = JSON.parse(file.metadata || "{}") as Record<string, unknown>;
    expectedHash = typeof metadata.contentHash === "string" ? metadata.contentHash : null;
  } catch {
    expectedHash = null;
  }
  const contentHash = hashBuffer(bytes);
  if (expectedHash && expectedHash !== contentHash) {
    throw new EvidenceAccessError("Evidence source failed its integrity check", 409);
  }

  return {
    bytes,
    contentHash,
    fileName: file.fileName || file.title || "evidence",
    mimeType: safeMimeType(file.mimeType),
  };
}

export async function recordEvidenceSourceOpened(options: {
  userId: string;
  evidenceId: string;
  accessMethod: "managed_storage" | "source_url" | "signed_http";
  acceptanceRun?: string;
  hashMatched?: boolean;
}): Promise<void> {
  const file = await getEvidenceFile(options.userId, options.evidenceId);
  if (!file) throw new EvidenceAccessError("File not found", 404);
  const managed = Boolean(managedStorageKeyFromMetadata(file.metadata));
  if (!managed && !file.fileUrl) {
    throw new EvidenceAccessError("File not available for download", 404);
  }
  await createAuditLog({
    userId: options.userId,
    action: AUDIT_ACTIONS.EVIDENCE_SOURCE_OPENED,
    entityType: "evidence",
    entityId: file.id,
    details: {
      caseId: file.caseId,
      accessMethod: options.accessMethod,
      dispatchConfirmed: true,
      ...(options.acceptanceRun ? { acceptanceRun: options.acceptanceRun } : {}),
      ...(options.hashMatched !== undefined ? { hashMatched: options.hashMatched } : {}),
    },
  });
}
