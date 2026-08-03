import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("signed evidence access", () => {
  let app: TestApp;
  const owner = { id: "USER_EVIDENCE_ACCESS", name: "Owner", role: "user", email: "owner@example.com" };
  const other = { id: "USER_EVIDENCE_OTHER", name: "Other", role: "user", email: "other@example.com" };
  const originalBaseUrl = process.env.OAUTH_REDIRECT_BASE_URL;

  beforeAll(async () => {
    process.env.OAUTH_REDIRECT_BASE_URL = "https://api.example.test/laro";
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser({ id: owner.id, email: owner.email }),
      buildUser({ id: other.id, email: other.email }),
    ]);
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_EVIDENCE_ACCESS",
      userId: owner.id,
    }));
  });

  afterAll(() => {
    if (originalBaseUrl === undefined) delete process.env.OAUTH_REDIRECT_BASE_URL;
    else process.env.OAUTH_REDIRECT_BASE_URL = originalBaseUrl;
    app?.cleanup();
  });

  it("issues an owner-only HTTP link and rejects tampering, expiry, and changed bytes", async () => {
    const { createEvidenceFile } = await import("../../server/evidence");
    const {
      EvidenceAccessError,
      getEvidenceDownloadUrl,
      readSignedEvidenceDownload,
    } = await import("../../server/evidenceAccess");
    const { storagePut } = await import("../../server/storage");
    const source = Buffer.from("From: owner@example.com\nSubject: Evidence access proof\n\nVerified source bytes.");
    const stored = await storagePut(
      "evidence/CASE_EVIDENCE_ACCESS/manual/source.eml",
      source,
      "message/rfc822",
    );
    const evidenceId = await createEvidenceFile(owner.id, {
      id: "EVIDENCE_ACCESS_SOURCE",
      caseId: "CASE_EVIDENCE_ACCESS",
      title: "Evidence access proof",
      type: "email",
      source: "gmail",
      fileName: "source.eml",
      mimeType: "message/rfc822",
      fileUrl: stored.url,
      metadata: JSON.stringify({ storageKey: stored.key }),
      contentHash: stored.sha256,
    });

    await expect(app.makeCaller(other).evidenceFiles.getDownloadUrl({ id: evidenceId }))
      .rejects.toThrow("File not found");

    const issued = await app.makeCaller(owner).evidenceFiles.getDownloadUrl({ id: evidenceId });
    expect(issued.url).toMatch(/^http:\/\/localhost:3000\/api\/evidence-content\//);
    expect(issued.url).not.toContain("file://");
    expect(issued.url).not.toContain(app.tmpDir);
    await expect(getEvidenceDownloadUrl(
      owner.id,
      evidenceId,
      new Date(),
      "https://attacker.example",
    )).rejects.toThrow("loopback HTTP origin");

    const url = new URL(issued.url!);
    const expires = url.searchParams.get("expires") || undefined;
    const signature = url.searchParams.get("signature") || undefined;
    const opened = await readSignedEvidenceDownload({ evidenceId, expires, signature });
    expect(opened.bytes.equals(source)).toBe(true);
    expect(opened.contentHash).toBe(stored.sha256);
    expect(opened.mimeType).toBe("message/rfc822");

    await expect(readSignedEvidenceDownload({
      evidenceId: `${evidenceId}-tampered`,
      expires,
      signature,
    })).rejects.toBeInstanceOf(EvidenceAccessError);

    await expect(readSignedEvidenceDownload({
      evidenceId,
      expires,
      signature,
      now: new Date((Number(expires) + 1) * 1000),
    })).rejects.toThrow("invalid or expired");

    await storagePut(stored.key, Buffer.from("changed bytes"), "message/rfc822");
    await expect(readSignedEvidenceDownload({ evidenceId, expires, signature }))
      .rejects.toMatchObject({ status: 409 });
  });
});
