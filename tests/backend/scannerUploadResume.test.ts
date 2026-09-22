import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const electronState = vi.hoisted(() => ({ userDataPath: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => electronState.userDataPath },
}));

import {
  addFile,
  cancelPausedScanUpload as cancelOwnedPausedScanUpload,
  closeDatabase,
  createScan as createOwnedScan,
  getScan as getOwnedScan,
  getScanFiles as getOwnedScanFiles,
  initDatabase,
  setScanFileSelection as setOwnedScanFileSelection,
  updateFileStatus,
  updateScanProgress,
} from "../../src-main/database";
import { inspectRegularFile } from "../../src-main/fileApproval";
import { FileUploader } from "../../src-main/uploader";
import { MAX_EVIDENCE_FILE_BYTES } from "../../shared/evidenceFiles";
import { SCANNER_UPLOAD_PATH } from "../../shared/scannerUpload";

const OWNER = "owner-1";
const createScan = (scanId: string, caseId: string, caseName: string, autoUpload: boolean, excludedFolders: string[]) =>
  createOwnedScan(scanId, OWNER, caseId, caseName, autoUpload, excludedFolders);
const getScan = (scanId: string) => getOwnedScan(scanId, OWNER);
const getScanFiles = (scanId: string) => getOwnedScanFiles(scanId, OWNER);
const setScanFileSelection = (scanId: string, fileIds: string[]) => setOwnedScanFileSelection(scanId, fileIds, OWNER);
const cancelPausedScanUpload = (scanId: string) => cancelOwnedPausedScanUpload(scanId, OWNER);

describe("resumable desktop scanner uploader", () => {
  const scanId = "resume-scan";
  const fileId = "resume-file";
  const fileName = "approved.txt";
  let filePath: string;
  let approvedSha256: string;
  const resolveAuth = vi.fn(async () => ({
    sessionCookie: "laro_session=fresh-session",
    scannerSecret: "scanner-secret",
  }));

  beforeEach(async () => {
    resolveAuth.mockClear();
    electronState.userDataPath = await mkdtemp(join(tmpdir(), "laro-scanner-resume-"));
    initDatabase();
    createScan(scanId, "case-1", "Case one", false, []);
    filePath = join(electronState.userDataPath, fileName);
    await writeFile(filePath, "approved scanner evidence");
    const snapshot = await inspectRegularFile(filePath, MAX_EVIDENCE_FILE_BYTES);
    approvedSha256 = snapshot.sha256;
    addFile({
      id: fileId,
      path: filePath,
      name: fileName,
      size: snapshot.size,
      mimeType: "text/plain",
      modifiedAt: snapshot.modifiedAt,
      uploadStatus: "pending",
      uploadProgress: 0,
      contentHash: snapshot.sha256,
      sourceIdentity: snapshot.identity,
      sourceRealPath: snapshot.realPath,
    }, scanId);
    await setScanFileSelection(scanId, [fileId]);
  });

  afterEach(async () => {
    closeDatabase();
    await rm(electronState.userDataPath, { recursive: true, force: true });
  });

  function receipt(id = "EVIDENCE-1", resumed = false): Response {
    return new Response(JSON.stringify({ id, sha256: approvedSha256, resumed }), {
      status: resumed ? 200 : 201,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("does not dispatch approved bytes after the scanner owner changes", async () => {
    let currentOwner = OWNER;
    let checks = 0;
    const fetchImpl = vi.fn(async () => receipt());
    const uploader = new FileUploader({
      scanId,
      ownerId: OWNER,
      apiUrl: "http://127.0.0.1:3000",
      authorize: async () => {
        checks += 1;
        if (checks === 2) currentOwner = "owner-2";
        if (currentOwner !== OWNER) throw new Error("Scanner session changed");
      },
      resolveAuth,
      fetchImpl,
    });
    const errors: Error[] = [];
    uploader.on("error", (error: Error) => errors.push(error));

    await uploader.start();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errors[0]?.message).toMatch(/session changed/i);
    expect(getScanFiles(scanId)[0].evidenceId).toBeUndefined();
  });

  it("reacquires authentication after a 401 and completes the approved file", async () => {
    let requestCount = 0;
    const fetchImpl = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ error: "Authentication is required.", code: "AUTHENTICATION_REQUIRED" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return receipt();
    });
    const uploader = new FileUploader({
      scanId,
      ownerId: OWNER,
      authorize: async () => undefined,
      apiUrl: "http://127.0.0.1:3000",
      resolveAuth,
      fetchImpl,
      maxRetries: 1,
      wait: async () => undefined,
    });

    await uploader.start();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(resolveAuth).toHaveBeenCalledTimes(2);
    expect(getScanFiles(scanId)[0]).toMatchObject({
      uploadStatus: "completed",
      uploadProgress: 100,
      evidenceId: "EVIDENCE-1",
    });
    expect(getScan(scanId)).toMatchObject({ status: "completed", uploadedFiles: 1, failedFiles: 0 });
  });

  it("persists a network failure as retryable and resumes it after database restart", async () => {
    const interrupted = new FileUploader({
      scanId,
      ownerId: OWNER,
      authorize: async () => undefined,
      apiUrl: "https://laro.example.test/base",
      resolveAuth,
      maxRetries: 0,
      fetchImpl: vi.fn(async () => { throw new TypeError("network connection interrupted"); }),
      wait: async () => undefined,
    });
    await interrupted.start();
    expect(getScanFiles(scanId)[0]).toMatchObject({ uploadStatus: "retryable", evidenceId: undefined });
    expect(getScan(scanId)).toMatchObject({ status: "upload-paused" });

    closeDatabase();
    initDatabase();

    const bodies: unknown[] = [];
    const resumed = new FileUploader({
      scanId,
      ownerId: OWNER,
      authorize: async () => undefined,
      apiUrl: "https://laro.example.test/base",
      resolveAuth,
      maxRetries: 0,
      fetchImpl: vi.fn(async (input, init) => {
        expect(String(input)).toBe(`https://laro.example.test/base${SCANNER_UPLOAD_PATH}`);
        bodies.push(init?.body);
        return receipt("EVIDENCE-RESUMED", true);
      }),
    });
    await resumed.start();

    expect(bodies).toHaveLength(1);
    expect(Buffer.isBuffer(bodies[0])).toBe(true);
    expect(getScanFiles(scanId)[0]).toMatchObject({
      uploadStatus: "completed",
      evidenceId: "EVIDENCE-RESUMED",
      errorMessage: undefined,
    });
    expect(getScan(scanId)).toMatchObject({ status: "completed", uploadedFiles: 1 });
  });

  it("keeps a permanent server rejection distinct from a retryable failure", async () => {
    const uploader = new FileUploader({
      scanId,
      ownerId: OWNER,
      authorize: async () => undefined,
      apiUrl: "http://127.0.0.1:3000",
      resolveAuth,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: "Evidence file type is not supported.",
        code: "UNSUPPORTED_FILE_TYPE",
      }), {
        status: 415,
        headers: { "Content-Type": "application/json" },
      })),
      maxRetries: 3,
      wait: async () => undefined,
    });

    await uploader.start();

    expect(getScanFiles(scanId)[0]).toMatchObject({
      uploadStatus: "terminal",
      errorMessage: "Evidence file type is not supported.",
    });
    expect(getScan(scanId)).toMatchObject({ status: "failed", failedFiles: 1 });
  });

  it("recovers an in-flight row as retryable when the application restarts", () => {
    updateFileStatus(fileId, "uploading", 50, null);
    updateScanProgress({ scanId, status: "uploading" });
    closeDatabase();

    initDatabase();

    expect(getScanFiles(scanId)[0]).toMatchObject({
      uploadStatus: "retryable",
      uploadProgress: 0,
    });
    expect(getScan(scanId)).toMatchObject({
      status: "upload-paused",
    });
  });

  it("persists cancellation of a paused upload after restart and still permits resumption", async () => {
    updateFileStatus(fileId, "uploading", 50, null);
    updateScanProgress({ scanId, status: "uploading" });
    closeDatabase();
    initDatabase();

    expect(cancelPausedScanUpload(scanId)).toBe(true);
    expect(getScanFiles(scanId)[0]).toMatchObject({ uploadStatus: "cancelled" });
    expect(getScan(scanId)).toMatchObject({ status: "cancelled" });

    closeDatabase();
    initDatabase();
    expect(getScan(scanId)).toMatchObject({ status: "cancelled" });
    const resumed = new FileUploader({
      scanId,
      ownerId: OWNER,
      authorize: async () => undefined,
      apiUrl: "http://127.0.0.1:3000",
      resolveAuth,
      fetchImpl: vi.fn(async () => receipt("EVIDENCE-AFTER-CANCEL")),
      maxRetries: 0,
    });
    await resumed.start();
    expect(getScanFiles(scanId)[0]).toMatchObject({ uploadStatus: "completed", evidenceId: "EVIDENCE-AFTER-CANCEL" });
    expect(getScan(scanId)).toMatchObject({ status: "completed" });
  });

  it("aborts an active request and preserves the approved file as cancelled/resumable", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestStarted();
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const uploader = new FileUploader({
      scanId,
      ownerId: OWNER,
      authorize: async () => undefined,
      apiUrl: "http://127.0.0.1:3000",
      resolveAuth,
      fetchImpl,
      maxRetries: 0,
    });

    const run = uploader.start();
    await started;
    uploader.stop();
    await run;

    expect(getScanFiles(scanId)[0]).toMatchObject({
      uploadStatus: "cancelled",
      evidenceId: undefined,
    });
    expect(getScan(scanId)).toMatchObject({ status: "cancelled" });
  });
});
