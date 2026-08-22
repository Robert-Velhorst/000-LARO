import { describe, expect, it, vi } from "vitest";
import {
  readBoundedResponseJson,
  readBoundedResponseText,
  withBoundedHttpResponse,
} from "../../server/boundedHttpResponse";
import { withByteReadAdmission } from "../../server/boundedBytes";

describe("bounded HTTP response readers", () => {
  it("rejects an oversized declared body before reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("ignored"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: { "content-length": "101" },
    });

    await expect(readBoundedResponseText(response, {
      maxBytes: 100,
      label: "Provider response",
    })).rejects.toThrow("Provider response exceeds the 100 bytes response limit");
    expect(cancelled).toBe(true);
  });

  it("rejects a streamed body once it crosses the byte ceiling", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(60));
        controller.enqueue(new Uint8Array(41));
        controller.close();
      },
    }));

    await expect(readBoundedResponseText(response, {
      maxBytes: 100,
      label: "Provider response",
    })).rejects.toThrow("Provider response exceeds the 100 bytes response limit");
  });

  it("parses valid bounded JSON and text responses", async () => {
    await expect(readBoundedResponseJson<{ ok: boolean }>(
      new Response('{"ok":true}'),
      { maxBytes: 100, label: "JSON response" },
    )).resolves.toEqual({ ok: true });

    await expect(readBoundedResponseText(
      new Response("bounded text"),
      { maxBytes: 100, label: "Text response" },
    )).resolves.toBe("bounded text");
  });

  it("rejects before provider dispatch when byte-read admission is full", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const accepted = Array.from({ length: 20 }, () => withByteReadAdmission(() => blocked));
    const request = vi.fn(async () => new Response("should not be requested"));
    await vi.waitFor(() => expect(request).not.toHaveBeenCalled());

    await expect(withBoundedHttpResponse(request, (response) => readBoundedResponseText(response, {
      maxBytes: 100,
      label: "Provider response",
    }))).rejects.toThrow("Evidence import queue is full");
    expect(request).not.toHaveBeenCalled();

    release();
    await Promise.all(accepted);
  });
});
