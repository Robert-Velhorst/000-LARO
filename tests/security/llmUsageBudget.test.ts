import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeLLM } from "../../server/llm";
import { resetLLMUsageBudgetForTests } from "../../server/llmUsageBudget";

function configureProvider(): void {
  vi.stubEnv("GROQ_API_KEY", "test-groq-key");
  vi.stubEnv("LARO_GROQ_MODEL", "budget-test-model");
}

function response(): Response {
  return new Response(JSON.stringify({
    id: "budget-response",
    created: 1,
    model: "budget-test-model",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  resetLLMUsageBudgetForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("canonical owner-scoped model budget", () => {
  it("rejects operation context and output limits before provider dispatch", async () => {
    configureProvider();
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);

    await expect(invokeLLM({
      provider: "groq",
      budget: { ownerId: "BUDGET_BOUNDS_OWNER", operation: "hybrid_search" },
      messages: [{ role: "user", content: "x".repeat(13_000) }],
      max_tokens: 300,
    })).rejects.toMatchObject({ limit: "operationInput", code: "PAYLOAD_TOO_LARGE" });

    await expect(invokeLLM({
      provider: "groq",
      budget: { ownerId: "BUDGET_BOUNDS_OWNER", operation: "hybrid_search" },
      messages: [{ role: "user", content: "bounded" }],
      max_tokens: 301,
    })).rejects.toMatchObject({ limit: "operationOutput", code: "PAYLOAD_TOO_LARGE" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shares one external request window across operations and routes", async () => {
    configureProvider();
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    const ownerId = "CROSS_ROUTE_BUDGET_OWNER";

    for (let index = 0; index < 20; index += 1) {
      await invokeLLM({
        provider: "groq",
        budget: {
          ownerId,
          operation: index % 2 === 0 ? "hybrid_search" : "case_assistant",
        },
        messages: [{ role: "user", content: `bounded request ${index}` }],
      });
    }

    await expect(invokeLLM({
      provider: "groq",
      budget: { ownerId, operation: "timeline_correction" },
      messages: [{ role: "user", content: "route switching must not reset the owner budget" }],
    })).rejects.toMatchObject({ limit: "requests", code: "TOO_MANY_REQUESTS" });
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("enforces cumulative owner input-character and requested-output budgets", async () => {
    configureProvider();
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);

    for (let index = 0; index < 7; index += 1) {
      await invokeLLM({
        provider: "groq",
        budget: { ownerId: "CHARACTER_BUDGET_OWNER", operation: "timeline_correction" },
        messages: [{ role: "user", content: `${index}:${"x".repeat(130_000)}` }],
      });
    }
    await expect(invokeLLM({
      provider: "groq",
      budget: { ownerId: "CHARACTER_BUDGET_OWNER", operation: "timeline_correction" },
      messages: [{ role: "user", content: `final:${"x".repeat(130_000)}` }],
    })).rejects.toMatchObject({ limit: "inputCharacters", code: "TOO_MANY_REQUESTS" });
    expect(fetchMock).toHaveBeenCalledTimes(7);

    await invokeLLM({
      provider: "groq",
      budget: { ownerId: "OUTPUT_BUDGET_OWNER", operation: "dossier_comparison" },
      messages: [{ role: "user", content: "first bounded comparison" }],
      max_tokens: 32_768,
    });
    await invokeLLM({
      provider: "groq",
      budget: { ownerId: "OUTPUT_BUDGET_OWNER", operation: "dossier_comparison" },
      messages: [{ role: "user", content: "second bounded comparison" }],
      max_tokens: 32_768,
    });
    await expect(invokeLLM({
      provider: "groq",
      budget: { ownerId: "OUTPUT_BUDGET_OWNER", operation: "dossier_comparison" },
      messages: [{ role: "user", content: "third request must not reach the provider" }],
      max_tokens: 15_000,
    })).rejects.toMatchObject({ limit: "outputTokens", code: "TOO_MANY_REQUESTS" });
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it("rejects a third cross-operation request while two owner requests are in flight", async () => {
    configureProvider();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ownerId = "CONCURRENT_BUDGET_OWNER";
    const controllers = [new AbortController(), new AbortController()];
    const pending = ["case_assistant", "document_analysis"].map((operation, index) => invokeLLM({
      provider: "groq",
      budget: { ownerId, operation: operation as "case_assistant" | "document_analysis" },
      messages: [{ role: "user", content: "hold provider request" }],
      signal: controllers[index].signal,
    }));
    const settled = Promise.allSettled(pending);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await expect(invokeLLM({
      provider: "groq",
      budget: { ownerId, operation: "hybrid_search" },
      messages: [{ role: "user", content: "must be rejected before fetch" }],
    })).rejects.toMatchObject({ limit: "concurrency", code: "TOO_MANY_REQUESTS" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    controllers.forEach((controller) => controller.abort(new Error("test cleanup")));
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
  });
});
