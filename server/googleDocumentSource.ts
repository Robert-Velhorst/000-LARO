import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { emailAccounts } from "./schema";
import { getProviderAccessToken } from "./providerConnections";
import { readBoundedResponseBytes, readBoundedResponseJson, withBoundedHttpResponse } from "./boundedHttpResponse";
import { MAX_EVIDENCE_BASE64_CHARS, MAX_EVIDENCE_FILE_BYTES, isSupportedDocumentAnalysisMimeType } from "../shared/evidenceFiles";
import { escapeDriveQueryLiteral } from "./googleDriveService";
import { SourceSkip, type SourceConfiguration, type SourceProvenance, type SourceStepResult, type SourceWork } from "./documentSourceTypes";

type GoogleConfiguration = Exclude<SourceConfiguration, { kind: "local" }>;
const id = z.string().min(1).max(1000);
const pagePayload = z.object({ pageToken: z.string().max(8000).optional(), folderId: id.optional() });
const partSchema = z.object({ partId: z.string().optional(), filename: z.string().default(""), mimeType: z.string().default("application/octet-stream"),
  body: z.object({ attachmentId: id.optional(), data: z.string().optional(), size: z.number().int().nonnegative().optional() }).default({}),
  parts: z.array(z.unknown()).max(2000).optional() });
const messageSchema = z.object({ id, threadId: id.optional(), historyId: z.string().min(1), internalDate: z.string().optional(),
  labelIds: z.array(z.string()).max(1000).optional(), payload: z.unknown() });
const fileSchema = z.object({ id, name: z.string().min(1), mimeType: z.string().min(1), version: z.string().min(1),
  size: z.string().regex(/^\d+$/).optional(), modifiedTime: z.string().optional(), trashed: z.boolean().optional() });
const FOLDER = "application/vnd.google-apps.folder";
const EXPORTABLE = new Set(["document", "spreadsheet", "presentation", "drawing"].map((type) => `application/vnd.google-apps.${type}`));
const FILE_FIELDS = "id,name,mimeType,size,version,modifiedTime,trashed";

export async function requireSourceGoogleAccount(userId: string, accountId: string) {
  const db = await getDb();
  const account = db.select().from(emailAccounts).where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, userId),
    eq(emailAccounts.provider, "gmail"), eq(emailAccounts.status, "connected"))).get();
  if (!account?.accessToken) throw new Error("Selected Google account is unavailable; connect your account first");
  return account;
}

async function accessToken(userId: string, accountId: string): Promise<string> {
  return getProviderAccessToken({ userId, accountId, provider: "gmail", refreshWindowMs: 30_000 });
}

async function request<T>(userId: string, config: GoogleConfiguration, url: URL, read: (response: Response) => Promise<T>): Promise<T> {
  const token = await accessToken(userId, config.accountId);
  return withBoundedHttpResponse(() => fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: "error" }), async (response) => {
    if (!response.ok) throw new Error(`Google source request failed (HTTP ${response.status}); check the connection and retry`);
    const result = await read(response);
    await requireSourceGoogleAccount(userId, config.accountId);
    return result;
  });
}
function endpoint(service: "gmail" | "drive", suffix: string, params: Record<string, string> = {}): URL {
  const url = new URL(service === "gmail" ? `https://gmail.googleapis.com/gmail/v1/users/me/${suffix}` : `https://www.googleapis.com/drive/v3/${suffix}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}
function json(userId: string, config: GoogleConfiguration, url: URL, large = false) {
  return request(userId, config, url, (response) => readBoundedResponseJson<unknown>(response, {
    maxBytes: large ? MAX_EVIDENCE_BASE64_CHARS + 128 * 1024 : 1024 * 1024, label: "Google source response",
  }));
}

export async function checkGoogleSourceConnection(userId: string, accountId: string, kind: "gmail" | "drive") {
  const account = await requireSourceGoogleAccount(userId, accountId);
  const config: GoogleConfiguration = kind === "gmail" ? { kind, accountId, query: "", includeSpamTrash: false } : { kind, accountId };
  try {
    const profile = kind === "gmail"
      ? z.object({ emailAddress: z.string().email() }).parse(await json(userId, config, endpoint("gmail", "profile"))).emailAddress
      : z.object({ user: z.object({ emailAddress: z.string().email() }) }).parse(await json(userId, config,
        endpoint("drive", "about", { fields: "user(emailAddress)" }))).user.emailAddress;
    if (!account.email || profile.toLowerCase() !== account.email.toLowerCase()) throw new Error("Account identity mismatch");
    return { accessible: true, checkedAt: new Date(), message: null };
  } catch {
    return { accessible: false, checkedAt: new Date(),
      message: "Google access could not be verified. Reconnect the selected account with the required permissions, or retry if Google is temporarily unavailable." };
  }
}
function decodeBytes(data: string, declaredSize?: number): Buffer {
  if (data.length > MAX_EVIDENCE_BASE64_CHARS || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)) throw new Error("Invalid or oversized Google document encoding");
  const bytes = Buffer.from(data, "base64url");
  if (bytes.toString("base64url") !== data.replace(/=+$/, "")) throw new Error("Incomplete Google document encoding");
  if (!bytes.length || bytes.length > MAX_EVIDENCE_FILE_BYTES) throw new SourceSkip("Empty file or larger than the 7 MB document limit; legal relevance has not been assessed", {
    outcome: "needs_review", code: bytes.length ? "size_limit" : "empty_file", basis: "downloaded_bytes",
    facts: { sizeBytes: bytes.length, limitBytes: MAX_EVIDENCE_FILE_BYTES } });
  if (declaredSize !== undefined && bytes.length !== declaredSize) throw new Error("Google document size changed or response was incomplete");
  return bytes;
}
function flattenParts(payload: unknown) {
  const pending = [{ value: payload, depth: 0 }];
  const parts: Array<z.infer<typeof partSchema>> = [];
  while (pending.length) {
    const next = pending.pop()!;
    if (next.depth > 30 || parts.length >= 2000) throw new Error("Gmail message part structure exceeds the supported limit");
    const part = partSchema.parse(next.value);
    parts.push(part);
    for (const child of part.parts || []) pending.push({ value: child, depth: next.depth + 1 });
  }
  return parts;
}

async function executeGmail(userId: string, config: Extract<GoogleConfiguration, { kind: "gmail" }>, kind: string, raw: unknown): Promise<SourceStepResult> {
  if (kind === "gmail_page") {
    const payload = pagePayload.parse(raw);
    const url = endpoint("gmail", "messages", { maxResults: "100", q: config.query, includeSpamTrash: String(config.includeSpamTrash), ...(payload.pageToken ? { pageToken: payload.pageToken } : {}) });
    const page = z.object({ messages: z.array(z.object({ id })).max(100).default([]), nextPageToken: z.string().min(1).max(8000).optional() }).parse(await json(userId, config, url));
    const children: SourceWork[] = page.messages.map((message) => ({ kind: "gmail_message", key: message.id, label: message.id, isDocument: false, payload: { messageId: message.id } }));
    if (page.nextPageToken) children.push({ kind, key: page.nextPageToken, label: "Gmail inventory", isDocument: false, payload: { pageToken: page.nextPageToken }, continuation: true });
    return { children };
  }
  const payload = z.object({ messageId: id, partId: z.string().optional() }).parse(raw);
  const messagePath = `messages/${encodeURIComponent(payload.messageId)}`;
  const message = messageSchema.parse(await json(userId, config, endpoint("gmail", messagePath, { format: "full" }), true));
  if (message.id !== payload.messageId) throw new Error("Gmail returned a different message");
  const assertUnchanged = async () => {
    const after = z.object({ id, historyId: z.string().min(1) }).parse(await json(userId, config,
      endpoint("gmail", messagePath, { format: "full", fields: "id,historyId" })));
    if (after.id !== message.id || after.historyId !== message.historyId) throw new Error("Gmail message changed during download; retry to read one complete version");
  };
  const provenance: SourceProvenance = { source: "gmail", objectId: message.id, accountId: config.accountId, gmailMessageId: message.id,
    gmailThreadId: message.threadId, gmailLabelIds: message.labelIds, version: message.historyId };
  const parts = flattenParts(message.payload);
  if (kind === "gmail_message") {
    const children: SourceWork[] = [{ kind: "gmail_raw", key: message.id, label: `${message.id}.eml`, isDocument: true, payload: { messageId: message.id } }];
    for (const part of parts.filter((part) => part.filename)) {
      if (part.partId === undefined) throw new Error("Gmail attachment has no stable part identity");
      children.push({ kind: "gmail_attachment", key: JSON.stringify([message.id, part.partId]), label: part.filename, isDocument: true, payload: { messageId: message.id, partId: part.partId } });
    }
    return { children };
  }
  if (kind === "gmail_raw") {
    const original = z.object({ id, raw: z.string() }).parse(await json(userId, config, endpoint("gmail", messagePath, { format: "raw" }), true));
    if (original.id !== message.id) throw new Error("Gmail returned a different original message");
    await assertUnchanged();
    return { document: { fileName: `${message.id}.eml`, sourcePath: `gmail/${config.accountId}/${message.id}/raw`, mimeType: "message/rfc822", bytes: decodeBytes(original.raw), provenance } };
  }
  if (kind !== "gmail_attachment") throw new Error("Unknown Gmail source work type");
  const part = parts.find((part) => part.partId === payload.partId);
  if (!part?.filename) throw new Error("Gmail attachment changed or is no longer available");
  const attachmentFacts = { messageId: message.id, partId: payload.partId ?? null, version: message.historyId,
    declaredMimeType: part.mimeType, sizeBytes: part.body.size ?? null };
  if (!isSupportedDocumentAnalysisMimeType(part.mimeType)) throw new SourceSkip("Google reports an unsupported attachment format. Contents and legal relevance have not been assessed; review or convert the original.", {
    outcome: "needs_review", code: "unsupported_format", basis: "provider_metadata", facts: attachmentFacts });
  if ((part.body.size || 0) > MAX_EVIDENCE_FILE_BYTES) throw new SourceSkip("Google reports an attachment above the import limit; review the original", {
    outcome: "needs_review", code: "size_limit", basis: "provider_metadata", facts: { ...attachmentFacts, limitBytes: MAX_EVIDENCE_FILE_BYTES } });
  const body = part.body.attachmentId
    ? z.object({ data: z.string(), size: z.number().int().nonnegative().optional() }).parse(await json(userId, config, endpoint("gmail", `${messagePath}/attachments/${encodeURIComponent(part.body.attachmentId)}`), true))
    : part.body;
  if (!body.data) throw new Error("Gmail attachment content is missing");
  await assertUnchanged();
  return { document: { fileName: part.filename, sourcePath: `gmail/${config.accountId}/${message.id}/part/${payload.partId}`, mimeType: part.mimeType,
    bytes: decodeBytes(body.data, body.size), provenance: { ...provenance, objectId: `${message.id}/${payload.partId}`, attachmentId: part.body.attachmentId } } };
}

async function executeDrive(userId: string, config: Extract<GoogleConfiguration, { kind: "drive" }>, kind: string, raw: unknown): Promise<SourceStepResult> {
  if (kind === "drive_page") {
    const payload = pagePayload.parse(raw);
    const folderId = payload.folderId ?? config.folderId;
    const q = folderId ? `'${escapeDriveQueryLiteral(folderId)}' in parents and trashed = false` : `trashed = false and mimeType != '${FOLDER}'`;
    const page = z.object({ files: z.array(fileSchema).max(100).default([]), nextPageToken: z.string().min(1).max(8000).optional(), incompleteSearch: z.boolean().optional() })
      .parse(await json(userId, config, endpoint("drive", "files", { q, pageSize: "100", corpora: "user", includeItemsFromAllDrives: "true", supportsAllDrives: "true",
        fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`, ...(payload.pageToken ? { pageToken: payload.pageToken } : {}) })));
    if (page.incompleteSearch) throw new Error("Google Drive search is incomplete; select a narrower source folder and start again");
    const children: SourceWork[] = page.files.map((file) => file.mimeType === FOLDER
      ? { kind: "drive_page", key: JSON.stringify([file.id, ""]), label: file.name, isDocument: false, payload: { folderId: file.id } }
      : { kind: "drive_file", key: file.id, label: file.name, isDocument: true, payload: { fileId: file.id } });
    if (page.nextPageToken) children.push({ kind, key: JSON.stringify([folderId || "", page.nextPageToken]), label: "Drive inventory", isDocument: false,
      payload: { folderId, pageToken: page.nextPageToken }, continuation: true });
    return { children };
  }
  if (kind !== "drive_file") throw new Error("Unknown Drive source work type");
  const payload = z.object({ fileId: id }).parse(raw);
  const filePath = `files/${encodeURIComponent(payload.fileId)}`;
  const metadata = () => json(userId, config, endpoint("drive", filePath, { fields: FILE_FIELDS, supportsAllDrives: "true" })).then((value) => fileSchema.parse(value));
  const before = await metadata();
  if (before.id !== payload.fileId || before.trashed) throw new Error("Drive file is no longer available at the selected identity");
  const exported = EXPORTABLE.has(before.mimeType);
  const mimeType = exported ? "application/pdf" : before.mimeType;
  const driveFacts = { fileId: before.id, version: before.version, declaredMimeType: before.mimeType, sizeBytes: before.size ?? null };
  if (!isSupportedDocumentAnalysisMimeType(mimeType)) throw new SourceSkip("Google reports an unsupported Drive format. Contents and legal relevance have not been assessed; review or convert the original.", {
    outcome: "needs_review", code: "unsupported_format", basis: "provider_metadata", facts: driveFacts });
  if (!exported && before.size && Number(before.size) > MAX_EVIDENCE_FILE_BYTES) throw new SourceSkip("Google reports a Drive file above the import limit; review the original", {
    outcome: "needs_review", code: "size_limit", basis: "provider_metadata", facts: { ...driveFacts, limitBytes: MAX_EVIDENCE_FILE_BYTES } });
  const url = exported ? endpoint("drive", `${filePath}/export`, { mimeType }) : endpoint("drive", filePath, { alt: "media", supportsAllDrives: "true" });
  const bytes = await request(userId, config, url, (response) => readBoundedResponseBytes(response, { maxBytes: MAX_EVIDENCE_FILE_BYTES, label: "Drive document" }));
  const after = await metadata();
  if (after.id !== before.id || after.version !== before.version || after.trashed) throw new Error("Drive document changed during download; retry to read one complete version");
  if (!bytes.length) throw new SourceSkip("Drive document is empty; review the original", {
    outcome: "needs_review", code: "empty_file", basis: "downloaded_bytes", facts: { ...driveFacts, sizeBytes: 0 } });
  if (!exported && before.size !== undefined && bytes.length !== Number(before.size)) throw new Error("Drive download is incomplete");
  return { document: { fileName: exported ? `${before.name}.pdf` : before.name, sourcePath: `drive/${config.accountId}/${before.id}`, mimeType, bytes,
    provenance: { source: "google_drive", accountId: config.accountId, driveAccountId: config.accountId, objectId: before.id, driveFileId: before.id,
      version: before.version, modifiedTime: before.modifiedTime, sourceMimeType: before.mimeType } } };
}

export async function executeGoogleSourceWork(userId: string, config: GoogleConfiguration, kind: string, payload: unknown): Promise<SourceStepResult> {
  return config.kind === "gmail" ? executeGmail(userId, config, kind, payload) : executeDrive(userId, config, kind, payload);
}
