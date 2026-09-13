import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

(sqliteAvailable ? describe : describe.skip)("autonomous document inbox", () => {
  let app: TestApp;
  const owner = { id: "INBOX_OWNER", email: "inbox@example.test", role: "user" };
  const other = { id: "INBOX_OTHER", email: "other-inbox@example.test", role: "user" };
  const upload = (text: string, fileName = "letter.txt") => app.makeCaller(owner).documentInbox.upload({
    fileName, mimeType: "text/plain", base64: Buffer.from(text).toString("base64"),
  });
  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
  });
  afterAll(() => app?.cleanup());
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("preserves an unassigned original and scopes every operation to its owner", async () => {
    const text = "An original document without an identified case.";
    const item = await upload(text);
    expect(await app.makeCaller(owner).cases.list()).toMatchObject({ cases: [] });
    const download = await app.makeCaller(owner).documentInbox.download({ id: item.id });
    expect(Buffer.from(download.base64, "base64").toString()).toBe(text);
    expect((await app.makeCaller(other).documentInbox.list()).items).toEqual([]);
    for (const method of ["get", "download", "process"]) {
      await expect(app.makeCaller(other).documentInbox[method]({ id: item.id })).rejects.toThrow();
    }
    await expect(app.makeCaller(null).documentInbox.list()).rejects.toThrow();
    expect(await upload(text)).toMatchObject({ id: item.id, duplicate: true });
    expect((await upload(text + " Revised.")).id).not.toBe(item.id);
  });

  it("stores long original names without making Windows storage paths too long", async () => {
    const name = `${"document-".repeat(27)}.txt`;
    const item = await upload("Preserve these original bytes.", name);
    const { readInboxOriginal } = await import("../../server/documentInbox");
    const original = await readInboxOriginal(owner.id, item.id);
    expect(original.row.fileName).toBe(name);
    expect(original.bytes.toString()).toBe("Preserve these original bytes.");
    expect(original.row.storageKey.split("/").at(-1)!.length).toBeLessThan(80);
  });

  it("discovers a dossier in the contents, creates it and adds later documents exactly once", async () => {
    const first = await upload("Zaaknummer: ARN-2026-4501\nOp 2026-08-01 verklaart de gemeente dat het besluit is verstuurd.", "unrelated-name.txt");
    const processed = await app.makeCaller(owner).documentInbox.process({ id: first.id });
    expect(processed.decision).toBe("created");
    expect(processed.caseId).toBeTruthy();
    const second = await upload("Zaaknummer: ARN-2026-4501\nOp 2026-08-12 moet de gemeente het ontbrekende stuk toezenden.", "reply.txt");
    expect(await app.makeCaller(owner).documentInbox.process({ id: second.id })).toMatchObject({
      decision: "assigned", caseId: processed.caseId,
    });
    await app.makeCaller(owner).documentInbox.process({ id: second.id });
    const files = await app.makeCaller(owner).evidenceFiles.byCase({ caseId: processed.caseId });
    expect(files).toHaveLength(2);
    const analyses = await app.db.select().from(app.schema.documentAnalyses);
    expect(analyses.filter((row: any) => row.caseId === processed.caseId)).toHaveLength(2);
    const logs = await app.db.select().from(app.schema.auditLogs);
    expect(logs.filter((row: any) => row.action === "inbox.organized" && row.entityId === second.id)).toHaveLength(1);
    expect((await app.makeCaller(owner).documentInbox.get({ id: first.id })).analysis.citations.length).toBeGreaterThan(0);
    await app.makeCaller(owner).cases.delete({ id: processed.caseId });
    expect((await app.makeCaller(owner).documentInbox.get({ id: first.id })).evidenceId).toBeNull();
    expect(Buffer.from((await app.makeCaller(owner).documentInbox.download({ id: first.id })).base64, "base64").toString()).toContain("ARN-2026-4501");
  });

  it("does not classify references from filenames, invent cases, or force ambiguous references", async () => {
    const before = (await app.makeCaller(owner).cases.list()).pagination.total;
    const unnamed = await upload("We discussed the matter yesterday.", "Zaaknummer ARN-2026-9000.txt");
    expect(await app.makeCaller(owner).documentInbox.process({ id: unnamed.id })).toMatchObject({ decision: "needs_review", caseId: null });
    const ambiguous = await upload("Zaaknummer: ARN-2026-1111\nVergelijk dossiernummer: ARN-2026-2222");
    expect(await app.makeCaller(owner).documentInbox.process({ id: ambiguous.id })).toMatchObject({ decision: "needs_review", caseId: null });
    expect((await app.makeCaller(owner).cases.list()).pagination.total).toBe(before);
  });

  it("does not automatically file a reference read from low-confidence OCR", async () => {
    const source = "Zaaknummer: OCR-2026-1199\nDe gemeente heeft het besluit verzonden.";
    const item = await upload(source, "uncertain-scan.txt");
    const { analyzeDocumentBytes } = await import("../../server/documentIntelligence");
    const analysis = await analyzeDocumentBytes({ bytes: Buffer.from(source), mimeType: "text/plain", deepAnalysis: false });
    await app.db.update(app.schema.documentInbox).set({ sourceText: source,
      analysis: JSON.stringify({ ...analysis, extractionMethod: "pdf_ocr", extractionConfidence: 62 }) }).where(eq(app.schema.documentInbox.id, item.id));
    const { organizeInboxDocument } = await import("../../server/documentInbox");
    expect(await organizeInboxDocument(owner.id, item.id)).toMatchObject({ decision: "needs_review", caseId: null });
    expect((await app.makeCaller(owner).documentInbox.get({ id: item.id })).reason).toContain("OCR");
  });

  it("respects review settings, rejects cross-owner assignment and allows explicit resolution", async () => {
    const { updateWorkflowPreferences } = await import("../../server/workflowPreferences");
    await updateWorkflowPreferences(owner.id, { autoOrganizeDocuments: false });
    const item = await upload("Dossiernummer: ZZ-2026-8001\nCorrespondentie over een geschil.");
    expect(await app.makeCaller(owner).documentInbox.process({ id: item.id })).toMatchObject({ decision: "needs_review" });
    const foreign = await app.makeCaller(other).cases.create({ clientName: "Foreign", clientEmail: other.email,
      caseType: "Other", caseSummary: "Foreign dossier", urgency: "Low" });
    await expect(app.makeCaller(owner).documentInbox.assign({ id: item.id, caseId: foreign.id })).rejects.toThrow();
    const own = await app.makeCaller(owner).cases.create({ clientName: "Own", clientEmail: owner.email,
      caseType: "Other", caseSummary: "Owned dossier", urgency: "Low" });
    const assigned = await app.makeCaller(owner).documentInbox.assign({ id: item.id, caseId: own.id });
    expect(assigned.caseId).toBe(own.id);
    expect(await app.makeCaller(owner).documentInbox.assign({ id: item.id, caseId: own.id })).toMatchObject({ evidenceId: assigned.evidenceId });
    const row = await app.db.select().from(app.schema.evidence).where(eq(app.schema.evidence.id, assigned.evidenceId));
    expect(JSON.parse(row[0].metadata).inboxId).toBe(item.id);
    await updateWorkflowPreferences(owner.id, { autoOrganizeDocuments: true });
  });

  it("can analyze a manually filed original later and populate its canonical chronology", async () => {
    const item = await upload("Op 2026-08-15 verklaart de gemeente dat de brief is verzonden.", "filed-first.txt");
    const own = await app.makeCaller(owner).cases.create({ clientName: "Manual first", clientEmail: owner.email,
      caseType: "Other", caseSummary: "Manual filing before analysis", urgency: "Low" });
    const assigned = await app.makeCaller(owner).documentInbox.assign({ id: item.id, caseId: own.id });
    await app.makeCaller(owner).documentInbox.process({ id: item.id });
    const rows = await app.db.select().from(app.schema.documentAnalyses).where(eq(app.schema.documentAnalyses.evidenceId, assigned.evidenceId));
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].result).timelineEvents.length).toBeGreaterThan(0);
  });

  it("keeps analysis local when external sharing is disabled", async () => {
    const caller = app.makeCaller(owner);
    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai", shareRawDocumentContent: false });
    vi.stubEnv("OPENAI_API_KEY", "test-not-a-real-key");
    const fetch = vi.fn(() => Promise.reject(new Error("No cloud requests allowed")));
    vi.stubGlobal("fetch", fetch);
    const item = await upload("Dossiernummer: LOCAL-2026-001\nU moet het ontbrekende besluit bijvoegen.", "private.txt");
    await caller.documentInbox.process({ id: item.id });
    expect((await caller.documentInbox.get({ id: item.id })).analysis.providerStatus).toBe("not_requested");
    expect(fetch).not.toHaveBeenCalled();
    await caller.userPreferences.updateWorkflow({ analysisProvider: "local", shareRawDocumentContent: true });
  });

  it("persists extraction failures without discarding the original and supports pagination", async () => {
    const item = await upload("Too short.", "short.txt");
    await expect(app.makeCaller(owner).documentInbox.process({ id: item.id })).rejects.toThrow("original is preserved");
    expect((await app.makeCaller(owner).documentInbox.get({ id: item.id })).error).toContain("original is preserved");
    expect(Buffer.from((await app.makeCaller(owner).documentInbox.download({ id: item.id })).base64, "base64").toString()).toBe("Too short.");
    const first = await app.makeCaller(owner).documentInbox.list({ view: "all", limit: 1, offset: 0 });
    const second = await app.makeCaller(owner).documentInbox.list({ view: "all", limit: 1, offset: 1 });
    expect(first.total).toBeGreaterThan(1);
    expect(first.items[0].id).not.toBe(second.items[0].id);
  });

  it.each([
    { shareRawDocumentContent: false },
    { analysisProvider: "local" as const },
  ])("rechecks analysis permission after extraction: %j", async (change) => {
    const caller = app.makeCaller(owner);
    const intelligence = await import("../../server/documentIntelligence");
    const originalExtract = intelligence.extractDocumentTextInAcquiredSlot;
    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai", shareRawDocumentContent: true });
    vi.stubEnv("OPENAI_API_KEY", "test-not-a-real-key");
    const fetch = vi.fn(() => Promise.reject(new Error("Revoked document must not leave this computer")));
    vi.stubGlobal("fetch", fetch);
    const extraction = vi.spyOn(intelligence, "extractDocumentTextInAcquiredSlot").mockImplementation(async (...args) => {
      const result = await originalExtract(...args);
      await caller.userPreferences.updateWorkflow(change);
      return result;
    });
    try {
      const text = "Private correspondence about an unresolved housing dispute, without a case reference.";
      const item = await upload(text, `revocation-${Object.keys(change)[0]}.txt`);
      await caller.documentInbox.process({ id: item.id });
      expect(extraction).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
      expect((await caller.documentInbox.get({ id: item.id })).evidenceId).toBeNull();
      expect(Buffer.from((await caller.documentInbox.download({ id: item.id })).base64, "base64").toString()).toBe(text);
    } finally {
      extraction.mockRestore();
      await caller.userPreferences.updateWorkflow({ analysisProvider: "local", shareRawDocumentContent: true });
    }
  });

  it("includes inbox data in account export and erases its managed source with the account", async () => {
    const user = { id: "INBOX_ERASE", email: "erase-inbox@example.test", role: "user" };
    await app.db.insert(app.schema.users).values(buildUser(user));
    const caller = app.makeCaller(user);
    const item = await caller.documentInbox.upload({ fileName: "erase.txt", mimeType: "text/plain",
      base64: Buffer.from("A synthetic document for account erasure verification.").toString("base64") });
    const row = (await app.db.select().from(app.schema.documentInbox).where(eq(app.schema.documentInbox.id, item.id)))[0];
    expect((await caller.gdpr.exportData()).data.document_inbox).toContainEqual(expect.objectContaining({ id: item.id }));
    expect(await caller.gdpr.deleteData({ confirm: true })).toMatchObject({ success: true, erasureStatus: "completed" });
    const { storageRead } = await import("../../server/storage");
    await expect(storageRead(row.storageKey)).rejects.toThrow();
    await expect(caller.documentInbox.get({ id: item.id })).rejects.toThrow();
  });
});
