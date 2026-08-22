import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_EVIDENCE_BASE64_CHARS } from "../../shared/evidenceFiles";

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
});
