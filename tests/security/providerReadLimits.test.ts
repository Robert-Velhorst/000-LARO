import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_EVIDENCE_BASE64_CHARS } from "../../shared/evidenceFiles";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const sqliteSuite = sqliteAvailable ? describe : describe.skip;

describe("provider byte-read limits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("rejects an oversized Gmail attachment from headers before reading its body", async () => {
    const bodyRead = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      headers: { get: () => String(MAX_EVIDENCE_BASE64_CHARS + 128 * 1024 + 1) },
      body: {
        [Symbol.asyncIterator]() {
          bodyRead();
          throw new Error("body should not be read");
        },
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getGmailAttachmentBytes } = await import("../../server/gmailService");

    await expect(getGmailAttachmentBytes("token", "message", "attachment"))
      .rejects.toThrow("Gmail attachment exceeds the 7 MB evidence limit");
    expect(bodyRead).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("bounds concurrent provider and local byte reads before work starts", async () => {
    const { withByteReadAdmission } = await import("../../server/boundedBytes");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = vi.fn();
    const accepted = Array.from({ length: 20 }, () => withByteReadAdmission(async () => {
      started();
      await blocked;
    }));
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(4));

    await expect(withByteReadAdmission(async () => undefined))
      .rejects.toThrow("Evidence import queue is full");
    release();
    await expect(Promise.all(accepted)).resolves.toHaveLength(20);
  });

  it("allows four concurrent Gmail reads without nested-admission deadlock", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string) => new Response(JSON.stringify({
      id: "message",
      threadId: "thread",
      snippet: "bounded",
      internalDate: "0",
    }))));
    const { getGmailMessage } = await import("../../server/gmailService");

    const reads = Array.from({ length: 4 }, (_, index) => getGmailMessage("token", String(index)));
    await expect(Promise.race([
      Promise.all(reads),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Gmail reads deadlocked")), 1_000);
      }),
    ])).resolves.toHaveLength(4);
  });
});

sqliteSuite("Gmail thread sync read limits", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await bootTestApp();
  });

  afterAll(() => app?.cleanup());

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("rejects an oversized Gmail thread response before processing it", async () => {
    const bodyRead = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ threads: [{ id: "thread-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce({
        headers: { get: () => String(MAX_EVIDENCE_BASE64_CHARS + 128 * 1024 + 1) },
        body: {
          [Symbol.asyncIterator]() {
            bodyRead();
            throw new Error("body should not be read");
          },
        },
        json: async () => ({ messages: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const { syncGmailForCase } = await import("../../server/gmailService");

    const result = await syncGmailForCase("owner", "case", "token");

    expect(result.processedThreads).toBe(0);
    expect(result.errors.join(" ")).toContain("exceeds the 7 MB evidence limit");
    expect(bodyRead).not.toHaveBeenCalled();
  });
});
