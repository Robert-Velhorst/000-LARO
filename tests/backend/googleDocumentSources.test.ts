import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

(sqliteAvailable ? describe : describe.skip)("case-neutral Google source intake", () => {
  let app: TestApp;
  const owner = { id: "GOOGLE_SOURCE_OWNER", email: "google-source@example.test", role: "user" };
  const other = { id: "GOOGLE_SOURCE_OTHER", email: "google-other@example.test", role: "user" };
  const accountId = "GOOGLE_SOURCE_ACCOUNT";
  const source = "Zaaknummer: GOOGLE-2026-8888\nOp 2026-08-01 verklaart de gemeente dat het besluit is verzonden.";
  const raw = Buffer.from(`From: gemeente@example.test\r\nTo: owner@example.test\r\nDate: Sat, 1 Aug 2026 12:00:00 +0200\r\nSubject: Besluit\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${source}`);
  const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
    const { encryptToken } = await import("../../server/emailOAuth");
    await app.db.insert(app.schema.emailAccounts).values({ id: accountId, userId: owner.id, provider: "gmail", email: owner.email,
      status: "connected", accessToken: encryptToken("controlled-test-token"), tokenExpiry: new Date(Date.now() + 3600_000) });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => app?.cleanup());
  const drain = async () => {
    const { runSourceQueueStep } = await import("../../server/documentSourceQueue");
    for (let i = 0; i < 40 && await runSourceQueueStep(); i++) { /* Drain this bounded fixture inventory. */ }
  };

  it("requires ownership of the selected connected account before contacting Google", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(app.makeCaller(other).documentSources.start({ kind: "gmail", accountId, query: "" })).rejects.toThrow(/account/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["gmail", "drive"] as const)("retains unsupported %s items for review with provider evidence, not a relevance verdict", async kind => {
    const fetcher = vi.fn(async () => response(kind === "drive"
      ? { id: "unsupported", name: "evidence.bin", mimeType: "application/octet-stream", version: "7", size: "42" }
      : { id: "unsupported", historyId: "7", payload: { parts: [{ partId: "1", filename: "evidence.bin", mimeType: "application/octet-stream", body: { size: 42 } }] } }));
    vi.stubGlobal("fetch", fetcher);
    const { executeGoogleSourceWork } = await import("../../server/googleDocumentSource");
    const promise = kind === "drive"
      ? executeGoogleSourceWork(owner.id, { kind, accountId }, "drive_file", { fileId: "unsupported" })
      : executeGoogleSourceWork(owner.id, { kind, accountId, query: "", includeSpamTrash: false }, "gmail_attachment", { messageId: "unsupported", partId: "1" });
    await expect(promise).rejects.toMatchObject({ check: { outcome: "needs_review", code: "unsupported_format", basis: "provider_metadata",
      contentAssessed: false, facts: { declaredMimeType: "application/octet-stream", version: "7" } } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["gmail", "drive"] as const)("verifies live %s access and identity without downloading documents", async (kind) => {
    const fetcher = vi.fn(async (input: string | URL) => {
      expect(String(input)).toContain(kind === "gmail" ? "/profile" : "/about");
      return response(kind === "gmail" ? { emailAddress: owner.email } : { user: { emailAddress: owner.email } });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await app.makeCaller(owner).documentSources.checkConnection({ accountId, kind });
    expect(result.accessible).toBe(true);
    expect(String(fetcher.mock.calls[0][0])).toContain(kind === "gmail" ? "/profile" : "/about");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["forbidden", "wrong-identity"])("does not treat a connected database label as live access: %s", async (condition) => {
    vi.stubGlobal("fetch", vi.fn(async () => condition === "forbidden" ? new Response("denied", { status: 403 }) : response({ emailAddress: "different@example.test" })));
    const result = await app.makeCaller(owner).documentSources.checkConnection({ accountId, kind: "gmail" });
    expect(result.accessible).toBe(false);
    expect(result.message).toContain("Reconnect");
  });

  it("blocks connection probes for another owner's account", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(app.makeCaller(other).documentSources.checkConnection({ accountId, kind: "drive" })).rejects.toThrow(/account/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("persists Gmail pagination and saves original RFC822 bytes plus an attachment without a preselected case", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input)); seen.push(url.toString());
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer controlled-test-token");
      if (url.pathname.endsWith("/messages")) return response(url.searchParams.has("pageToken") ? { messages: [{ id: "m2" }] } : { messages: [{ id: "m1" }], nextPageToken: "next-mail-page" });
      if (url.pathname.endsWith("/attachments/att1")) return response({ data: Buffer.from(source).toString("base64url"), size: Buffer.byteLength(source) });
      const id = url.pathname.split("/").pop();
      if (url.searchParams.get("format") === "raw") return response({ id, raw: raw.toString("base64url") });
      if (url.searchParams.get("format") === "full") return response({ id, threadId: "thread1", historyId: "100", internalDate: "1785578400000", labelIds: ["INBOX"],
        payload: { mimeType: "multipart/mixed", parts: id === "m1" ? [{ partId: "1", filename: "decision.txt", mimeType: "text/plain", body: { attachmentId: "att1", size: Buffer.byteLength(source) } }] : [] } });
      throw new Error(`Unexpected test request ${url.pathname}`);
    }));
    const caller = app.makeCaller(owner);
    const job = await caller.documentSources.start({ kind: "gmail", accountId, query: "", includeSpamTrash: false });
    await drain();
    const result = await caller.documentSources.get({ id: job.id });
    expect(result.job.status).toBe("completed");
    expect(result.counts.imported).toBe(3);
    expect(seen.some((url) => url.includes("pageToken=next-mail-page"))).toBe(true);
    const records = await caller.documentInbox.list({ view: "all" });
    const message = records.items.find((item: any) => item.fileName === "m1.eml");
    expect(Buffer.from((await caller.documentInbox.download({ id: message.id })).base64, "base64")).toEqual(raw);
    const evidence = await caller.evidenceFiles.byCase({ caseId: message.caseId });
    expect(evidence.filter((item: any) => item.source === "gmail")).toHaveLength(3);
    expect(evidence.map((item: any) => JSON.parse(item.metadata)).some((item: any) => item.accountId === accountId && item.attachmentId === "att1")).toBe(true);
  });

  it("retains Drive version provenance, follows all pages and detects a version changing during download", async () => {
    let changed = false;
    let v2Reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/files")) return response(url.searchParams.has("pageToken")
        ? { files: [{ id: "drive2", name: "changed.txt", mimeType: "text/plain", version: "1" }], incompleteSearch: false }
        : { files: [{ id: "drive1", name: "decision.txt", mimeType: "text/plain", version: "1" }], nextPageToken: "drive-page2", incompleteSearch: false });
      const id = url.pathname.split("/").pop();
      if (url.searchParams.get("alt") === "media") return new Response(source, { headers: { "content-type": "text/plain" } });
      if (id === "drive2" && ++v2Reads > 1) changed = true;
      return response({ id, name: id === "drive1" ? "decision.txt" : "changed.txt", mimeType: "text/plain", size: String(Buffer.byteLength(source)),
        version: id === "drive2" && changed ? "2" : "1", modifiedTime: "2026-08-01T10:00:00Z" });
    }));
    const caller = app.makeCaller(owner);
    const job = await caller.documentSources.start({ kind: "drive", accountId });
    await drain();
    const result = await caller.documentSources.get({ id: job.id });
    expect(result.job.status).toBe("completed_with_errors");
    expect(result.counts.imported).toBe(1);
    expect(result.counts.failed).toBe(1);
    expect(result.items.some((item: any) => item.error?.includes("changed"))).toBe(true);
    const evidence = await app.db.select().from(app.schema.evidence);
    const imported = evidence.find((item: any) => item.source === "google_drive");
    expect(JSON.parse(imported.metadata)).toMatchObject({ driveFileId: "drive1", driveAccountId: accountId, version: "1" });
  });

  it("does not report an incomplete Drive search as a complete inventory", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ files: [], incompleteSearch: true })));
    const job = await app.makeCaller(owner).documentSources.start({ kind: "drive", accountId, folderId: "different-scope" });
    await drain();
    const result = await app.makeCaller(owner).documentSources.get({ id: job.id });
    expect(result.job.status).toBe("completed_with_errors");
    expect(result.counts.imported).toBe(0);
    expect(result.items.some((item: any) => item.error?.includes("incomplete"))).toBe(true);
  });

  it("rejects a Gmail draft changing between metadata and original download", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("format") === "raw") return response({ id: "draft1", raw: raw.toString("base64url") });
      return response({ id: "draft1", historyId: String(++reads), labelIds: ["DRAFT"], payload: { mimeType: "text/plain" } });
    }));
    const { executeGoogleSourceWork } = await import("../../server/googleDocumentSource");
    await expect(executeGoogleSourceWork(owner.id, { kind: "gmail", accountId, query: "", includeSpamTrash: false }, "gmail_raw", { messageId: "draft1" }))
      .rejects.toThrow(/changed/i);
  });

  it("reports repeated Gmail cursors instead of silently completing an incomplete inventory", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ messages: [], nextPageToken: "repeated-page" })));
    const caller = app.makeCaller(owner);
    const job = await caller.documentSources.start({ kind: "gmail", accountId, query: "repeated-cursor-fixture" });
    await drain();
    const result = await caller.documentSources.get({ id: job.id });
    expect(result.job.status).toBe("completed_with_errors");
    expect(result.items.some((item) => item.error?.includes("repeated"))).toBe(true);
  });
});
