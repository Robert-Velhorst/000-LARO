import { afterEach, describe, expect, it, vi } from "vitest";
import { searchGmailMessageIds } from "../../server/gmailMessageSearch";

afterEach(() => vi.unstubAllGlobals());

describe("Gmail collection search", () => {
  it("follows nextPageToken with the same query and deduplicates message IDs", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ messages: [{ id: "a" }], nextPageToken: "page-two" }))
      .mockResolvedValueOnce(Response.json({ messages: [{ id: "a" }, { id: "b" }] }));
    vi.stubGlobal("fetch", fetcher);
    expect(await searchGmailMessageIds("test-token", "contract")).toEqual({ messages: [{ id: "a" }, { id: "b" }], warnings: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const url = new URL(fetcher.mock.calls[1][0]);
    expect(url.searchParams.get("q")).toBe("contract");
    expect(url.searchParams.get("pageToken")).toBe("page-two");
  });

  it("retains discovered messages but reports an incomplete search after a page failure", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ messages: [{ id: "a" }], nextPageToken: "next" }))
      .mockResolvedValueOnce(Response.json({ error: { message: "Unavailable" } }, { status: 503 })));
    const result = await searchGmailMessageIds("test-token", "contract");
    expect(result.messages).toEqual([{ id: "a" }]);
    expect(result.warnings.join(" ")).toMatch(/partial.*503/i);
  });

  it("bounds repeated provider cursors instead of looping", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ messages: [{ id: "a" }], nextPageToken: "same" }));
    vi.stubGlobal("fetch", fetcher);
    const result = await searchGmailMessageIds("test-token", "contract");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.warnings.join(" ")).toMatch(/partial.*repeated/i);
  });

  it("reports the bounded collection limit without claiming the mailbox is exhausted", async () => {
    let page = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      const current = page++;
      return Response.json({ messages: Array.from({ length: 100 }, (_, i) => ({ id: `${current}-${i}` })), nextPageToken: `page-${page}` });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await searchGmailMessageIds("test-token", "contract");
    expect(result.messages).toHaveLength(1000);
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(result.warnings.join(" ")).toMatch(/partial.*1000/i);
  });

  it("rejects malformed success payloads instead of reporting no mail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ messages: [{ unrelated: "field" }] })));
    const result = await searchGmailMessageIds("test-token", "contract");
    expect(result.messages).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/partial/i);
  });
});
