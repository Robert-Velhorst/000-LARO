import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ENV } from "../../server/_core/env";
import { scannerUploadRouter } from "../../server/scannerUpload";
import { SESSION_COOKIE_NAME } from "../../server/sessionCookie";
import { listenHttpServer } from "../../server/listen";
import { DESKTOP_SCANNER_HEADER } from "../../shared/desktopScannerAuth";
import { MAX_EVIDENCE_FILE_BYTES } from "../../shared/evidenceFiles";
import { SCANNER_UPLOAD_HEADERS, SCANNER_UPLOAD_PATH } from "../../shared/scannerUpload";
import { storageRead } from "../../server/storage";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildUser } from "../factories";

const suite = sqliteAvailable ? describe : describe.skip;

suite("bounded binary scanner upload boundary", () => {
  let app: TestApp;
  let server: Server;
  let origin: string;
  const scannerSecret = "scanner-binary-test-secret-that-is-long-enough-123456";
  const owner = buildUser({ id: "BINARY_SCANNER_OWNER", email: "binary-scanner@example.com" });
  const caseRow = buildCase({ id: "BINARY_SCANNER_CASE", userId: owner.id });
  const token = () => jwt.sign({ userId: owner.id }, ENV.JWT_SECRET, { expiresIn: "1h" });

  beforeAll(async () => {
    process.env.LARO_DESKTOP_SCANNER_SECRET = scannerSecret;
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(owner);
    await app.db.insert(app.schema.cases).values(caseRow);
    const httpApp = express();
    httpApp.use(cookieParser());
    httpApp.use(scannerUploadRouter);
    server = createServer(httpApp);
    const port = await listenHttpServer(server, 0, "127.0.0.1");
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
    });
    delete process.env.LARO_DESKTOP_SCANNER_SECRET;
    app?.cleanup();
  });

  function headers(uploadId: string, bytes: Buffer, sessionToken = token()): Record<string, string> {
    return {
      "Content-Type": "application/octet-stream",
      Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      [DESKTOP_SCANNER_HEADER]: scannerSecret,
      [SCANNER_UPLOAD_HEADERS.uploadId]: uploadId,
      [SCANNER_UPLOAD_HEADERS.caseId]: caseRow.id,
      [SCANNER_UPLOAD_HEADERS.fileName]: encodeURIComponent(`${uploadId}.txt`),
      [SCANNER_UPLOAD_HEADERS.fileMime]: "text/plain",
      [SCANNER_UPLOAD_HEADERS.evidenceType]: "document",
      [SCANNER_UPLOAD_HEADERS.approvedSha256]: createHash("sha256").update(bytes).digest("hex"),
      [SCANNER_UPLOAD_HEADERS.source]: "desktop_scanner",
    };
  }

  async function upload(uploadId: string, bytes: Buffer, sessionToken?: string): Promise<Response> {
    return fetch(`${origin}${SCANNER_UPLOAD_PATH}`, {
      method: "POST",
      headers: headers(uploadId, bytes, sessionToken),
      body: bytes as unknown as BodyInit,
    });
  }

  it("accepts multiple maximum-size files as separate raw requests and deduplicates a lost response retry", async () => {
    const firstBytes = Buffer.alloc(MAX_EVIDENCE_FILE_BYTES, 0x61);
    const secondBytes = Buffer.alloc(MAX_EVIDENCE_FILE_BYTES, 0x62);

    const first = await upload("max-file-a", firstBytes);
    expect(first.status).toBe(201);
    const firstReceipt = await first.json() as { id: string; resumed: boolean; sha256: string };
    expect(firstReceipt).toMatchObject({ resumed: false, sha256: headers("max-file-a", firstBytes)[SCANNER_UPLOAD_HEADERS.approvedSha256] });

    const second = await upload("max-file-b", secondBytes);
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ resumed: false });

    const retry = await upload("max-file-a", firstBytes);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ id: firstReceipt.id, resumed: true, sha256: firstReceipt.sha256 });

    const rows = await app.db.select().from(app.schema.evidence)
      .where(eq(app.schema.evidence.userId, owner.id));
    expect(rows).toHaveLength(2);
  }, 60_000);

  it("rejects an over-limit body before persistence", async () => {
    const bytes = Buffer.alloc(MAX_EVIDENCE_FILE_BYTES + 1, 0x63);
    const response = await upload("too-large", bytes);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    const rows = await app.db.select().from(app.schema.evidence)
      .where(eq(app.schema.evidence.userId, owner.id));
    expect(rows.find((row: { metadata: string | null }) => row.metadata?.includes("too-large"))).toBeUndefined();
  });

  it("rejects expired authentication without turning the upload into a terminal evidence row", async () => {
    const bytes = Buffer.from("approved evidence");
    const expired = jwt.sign({ userId: owner.id }, ENV.JWT_SECRET, { expiresIn: -1 });
    const response = await upload("expired-session", bytes, expired);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });

  it("rejects reuse of an upload identifier for different approved bytes", async () => {
    const original = Buffer.from("first approved version");
    const replacement = Buffer.from("different approved version");
    expect((await upload("immutable-upload-id", original)).status).toBe(201);
    const conflict = await upload("immutable-upload-id", replacement);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "UPLOAD_ID_CONFLICT" });
  });

  it("keeps the winning object intact when identical retries race", async () => {
    const bytes = Buffer.from("same approved bytes for concurrent retries");
    const responses = await Promise.all([
      upload("concurrent-retry", bytes),
      upload("concurrent-retry", bytes),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const receipts = await Promise.all(responses.map((response) => response.json())) as Array<{ id: string }>;
    expect(receipts[0].id).toBe(receipts[1].id);

    const [row] = await app.db.select().from(app.schema.evidence)
      .where(eq(app.schema.evidence.id, receipts[0].id));
    const metadata = JSON.parse(row.metadata || "{}") as { storageKey: string };
    expect(await storageRead(metadata.storageKey)).toEqual(bytes);
  });

  it("binds retries to the approved filename and metadata, not only the digest", async () => {
    const bytes = Buffer.from("metadata is part of the approval");
    expect((await upload("metadata-binding", bytes)).status).toBe(201);
    const altered = headers("metadata-binding", bytes);
    altered[SCANNER_UPLOAD_HEADERS.fileName] = encodeURIComponent("different-name.txt");
    const response = await fetch(`${origin}${SCANNER_UPLOAD_PATH}`, {
      method: "POST",
      headers: altered,
      body: bytes as unknown as BodyInit,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "UPLOAD_ID_CONFLICT" });
  });
});
