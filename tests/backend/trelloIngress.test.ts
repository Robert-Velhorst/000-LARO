import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTrelloAttachment } from "../../server/trelloService";

const { lookupMock, storagePutMock } = vi.hoisted(() => ({
  lookupMock: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
  storagePutMock: vi.fn().mockResolvedValue({ key: "stored-key", url: "stored-url" }),
}));

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));
vi.mock("../../server/storage", () => ({ storagePut: storagePutMock }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  storagePutMock.mockReset();
  storagePutMock.mockResolvedValue({ key: "stored-key", url: "stored-url" });
});

describe("Trello attachment ingress", () => {
  it("rejects an untrusted attachment origin before making a request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadTrelloAttachment(
      "http://127.0.0.1:3000/internal",
      "evidence.pdf",
    )).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves requests to the official Trello attachment endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadTrelloAttachment(
      "https://trello.com/1/cards/card/attachments/file/download/evidence.pdf?token=secret",
      "evidence.pdf",
    )).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain("secret");
  });

  it("rejects an approved hostname when DNS resolves it to a private address", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadTrelloAttachment(
      "https://trello.com/1/cards/card/attachments/file/download/evidence.pdf",
      "evidence.pdf",
    )).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables automatic redirects so every destination can be revalidated", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://trello.com/1/cards/card/attachments/file/download/evidence.pdf";

    await downloadTrelloAttachment(url, "evidence.pdf");

    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "manual" }));
  });

  it("does not follow a redirect away from the trusted Trello origins", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/internal" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadTrelloAttachment(
      "https://trello.com/1/cards/card/attachments/file/download/evidence.pdf",
      "evidence.pdf",
    )).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows Trello's documented redirect to its exact attachment storage host", async () => {
    vi.stubEnv("TRELLO_API_KEY", "trello-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://trello-attachments.s3.amazonaws.com/card/file/evidence.pdf" },
      }))
      .mockResolvedValueOnce(new Response("evidence bytes", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadTrelloAttachment(
      "https://api.trello.com/1/cards/card/attachments/file/download/evidence.pdf",
      "evidence.pdf",
      { token: "trello-token" },
    )).resolves.toEqual({ key: "stored-key", url: "stored-url" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toContain("trello-token");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has("authorization")).toBe(false);
    expect(storagePutMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an attachment whose declared size exceeds the byte limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("small body", {
      status: 200,
      headers: { "content-length": String(25 * 1024 * 1024 + 1) },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadTrelloAttachment(
      "https://api.trello.com/1/cards/card/attachments/file/download/evidence.pdf",
      "evidence.pdf",
    )).resolves.toBeNull();
    expect(storagePutMock).not.toHaveBeenCalled();
  });

  it("keeps the deadline active until the attachment body is complete", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("late body"));
          controller.close();
        }, 80);
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect((downloadTrelloAttachment as any)(
      "https://api.trello.com/1/cards/card/attachments/file/download/evidence.pdf",
      "evidence.pdf",
      { timeoutMs: 10 },
    )).resolves.toBeNull();
    expect(storagePutMock).not.toHaveBeenCalled();
  });

  it("enforces the byte limit while streaming when content-length is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("five!", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadTrelloAttachment(
      "https://api.trello.com/1/cards/card/attachments/file/download/evidence.pdf",
      "evidence.pdf",
      { maxBytes: 4 },
    )).resolves.toBeNull();
    expect(storagePutMock).not.toHaveBeenCalled();
  });
});
