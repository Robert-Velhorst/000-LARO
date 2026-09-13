import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeLLM } from "../../server/llm";
import { Agent } from "undici";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

function configureGroq(): void {
  vi.stubEnv("GROQ_API_KEY", "test-groq-key");
  vi.stubEnv("LARO_GROQ_MODEL", "test-model");
}

function invokeGroq(signal?: AbortSignal) {
  return invokeLLM({
    provider: "groq",
    messages: [{ role: "user", content: "Analyze bounded input" }],
    signal,
  });
}

function validGroqResponse(): Response {
  return new Response(JSON.stringify({
    id: "recovered-response",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  }), { status: 200 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LLM transport resource limits", () => {
  it("uses and disposes a request-scoped HTTP dispatcher for extended deadlines only", async () => {
    configureGroq();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit & { dispatcher?: Agent }) => validGroqResponse());
    vi.stubGlobal("fetch", fetchMock);
    await invokeLLM({ provider: "groq", messages: [{ role: "user", content: "Synthetic" }], requestTimeoutMs: 450_000 });
    const firstInit = fetchMock.mock.calls[0][1];
    expect(firstInit.dispatcher).toBeInstanceOf(Agent);
    expect(firstInit.dispatcher?.destroyed).toBe(true);
    await invokeGroq();
    const secondInit = fetchMock.mock.calls[1][1];
    expect(secondInit.dispatcher).toBeUndefined();
  });

  it("disposes the extended-request dispatcher after a failed fetch", async () => {
    configureGroq();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit & { dispatcher?: Agent }) => { throw new Error("connection failed"); });
    vi.stubGlobal("fetch", fetchMock);
    await expect(invokeLLM({ provider: "groq", messages: [{ role: "user", content: "Synthetic" }], requestTimeoutMs: 450_000 }))
      .rejects.toThrow("connection failed");
    expect(fetchMock.mock.calls[0][1].dispatcher?.destroyed).toBe(true);
  });
  it("rejects oversized declared response bodies before reading them", async () => {
    configureGroq();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
    })));

    await expect(invokeGroq()).rejects.toThrow("Groq response exceeds the 8 MB limit");
  });

  it("enforces the same byte ceiling on chunked responses", async () => {
    configureGroq();
    const body = JSON.stringify({
      id: "oversized",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      padding: "x".repeat(MAX_RESPONSE_BYTES),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    await expect(invokeGroq()).rejects.toThrow("Groq response exceeds the 8 MB limit");
  });

  it("applies the declared-size guard to native Anthropic responses", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
    })));

    await expect(invokeLLM({
      provider: "anthropic",
      messages: [{ role: "user", content: "Analyze" }],
    })).rejects.toThrow("Anthropic response exceeds the 8 MB limit");
  });

  it("ignores malformed length metadata and still parses the streamed body", async () => {
    configureGroq();
    const response = validGroqResponse();
    response.headers.set("content-length", "not-a-number");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(invokeGroq()).resolves.toMatchObject({ id: "recovered-response" });
  });

  it("fails closed when a bounded response is not valid JSON", async () => {
    configureGroq();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));

    await expect(invokeGroq()).rejects.toThrow("Groq returned invalid JSON");
  });

  it("bounds provider error snippets", async () => {
    configureGroq();
    const tailMarker = "TAIL_MUST_NOT_BE_MATERIALIZED";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `${"x".repeat(32 * 1024)}${tailMarker}`,
      { status: 502, statusText: "Bad Gateway" },
    )));

    let failure: Error | null = null;
    try {
      await invokeGroq();
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).not.toBeNull();
    expect(failure!.message.length).toBeLessThan(4 * 1024);
    expect(failure!.message).not.toContain(tailMarker);
  });

  it("propagates caller cancellation to the provider request", async () => {
    configureGroq();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (!init?.signal) return Promise.reject(new Error("missing transport signal"));
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }));
    const controller = new AbortController();
    const pending = invokeGroq(controller.signal);
    const rejected = expect(pending).rejects.toThrow("caller disconnected");
    controller.abort(new Error("caller disconnected"));

    await rejected;
  });

  it("aborts stalled providers at the total request deadline", async () => {
    configureGroq();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (!init?.signal) return Promise.reject(new Error("missing transport signal"));
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }));
    const pending = invokeGroq();
    const rejected = expect(pending).rejects.toThrow("Groq request exceeded the 300 second limit");
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

    await rejected;
  });

  it.each(["groq", "anthropic", "ollama"] as const)("rechecks authorization after queueing for %s", async (provider) => {
    configureGroq();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("LARO_OLLAMA_MODEL", "test-local-model");
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    let allowed = true;
    const beforeDispatch = vi.fn(async () => allowed);
    const pending = controllers.map((controller, index) => invokeLLM({
      provider, messages: [{ role: "user", content: "Synthetic authorization test" }],
      signal: controller.signal, ...(index === 2 ? { beforeDispatch } : {}),
    }));
    const settled = Promise.allSettled(pending);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(beforeDispatch).not.toHaveBeenCalled();
    allowed = false;
    controllers[0].abort(new Error("release occupied slot"));
    await vi.waitFor(() => expect(beforeDispatch.mock.calls.length > 0 || fetchMock.mock.calls.length > 2).toBe(true));
    const dispatchCount = fetchMock.mock.calls.length;
    controllers.forEach((controller) => controller.abort(new Error("test cleanup")));
    const results = await settled;
    expect(dispatchCount).toBe(2);
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(results[2]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("authorization changed") }) });
  });

  it("bounds a stalled dispatch authorization check and releases its slot", async () => {
    configureGroq();
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => validGroqResponse());
    vi.stubGlobal("fetch", fetchMock);
    const pending = invokeLLM({ provider: "groq", messages: [{ role: "user", content: "Synthetic" }],
      requestTimeoutMs: 25, beforeDispatch: () => new Promise<boolean>(() => {}) });
    const settled = pending.then(() => null, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(26);
    expect((await settled)?.message).toContain("0.025 second limit");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(invokeGroq()).resolves.toMatchObject({ id: "recovered-response" });
  });

  it("limits global concurrency and rejects queue overflow", async () => {
    configureGroq();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (!init?.signal) return Promise.reject(new Error("missing transport signal"));
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const pending = controllers.map((controller) => invokeGroq(controller.signal));
    const settled = Promise.allSettled(pending);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(invokeGroq()).rejects.toThrow("LLM request queue is full");

    controllers.forEach((controller) => controller.abort(new Error("test cleanup")));
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);

    fetchMock.mockImplementationOnce(async () => validGroqResponse());
    await expect(invokeGroq()).resolves.toMatchObject({ id: "recovered-response" });
  });

  it.each(["groq", "anthropic", "ollama"] as const)("honors an explicit bounded deadline for %s", async (provider) => {
    configureGroq();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("LARO_OLLAMA_MODEL", "test-local-model");
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = invokeLLM({ provider, messages: [{ role: "user", content: "Synthetic deadline test" }], requestTimeoutMs: 450_000 });
    const settled = pending.then(() => null, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(300_001);
    const abortedAtDefault = fetchMock.mock.calls[0][1]!.signal!.aborted;
    await vi.advanceTimersByTimeAsync(150_000);
    const error = await settled;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(abortedAtDefault).toBe(false);
    expect(error?.message).toContain("450 second limit");
  });

  it.each([0, -1, 600_001, Number.NaN, Number.POSITIVE_INFINITY, 1500.5])("rejects an invalid explicit transport budget %s before fetch", async (requestTimeoutMs) => {
    configureGroq();
    const fetchMock = vi.fn().mockResolvedValue(validGroqResponse());
    vi.stubGlobal("fetch", fetchMock);
    await expect(invokeLLM({ provider: "groq", messages: [{ role: "user", content: "Synthetic" }], requestTimeoutMs }))
      .rejects.toThrow("request timeout must be an integer from 1 to 600000 milliseconds");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
