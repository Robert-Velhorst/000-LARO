import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_LLM_PROVIDERS,
  LLM_PROVIDERS,
  getLLMProviderDescriptors,
  invokeLLM,
} from "../../server/llm";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("multi-provider LLM adapter", () => {
  it("reports each supported external provider without exposing credentials", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const providers = getLLMProviderDescriptors();

    expect(providers.map((provider) => provider.id)).toEqual(LLM_PROVIDERS);
    expect(providers.filter((provider) => provider.id !== "ollama").map((provider) => provider.id)).toEqual(EXTERNAL_LLM_PROVIDERS);
    expect(providers.find((provider) => provider.id === "openai")).toMatchObject({
      configured: true,
      label: "OpenAI",
    });
    expect(JSON.stringify(providers)).not.toContain("test-openai-key");
  });

  it("uses Ollama only through a loopback endpoint and sends no authorization header", async () => {
    vi.stubEnv("LARO_OLLAMA_MODEL", "qwen-test");
    vi.stubEnv("LARO_OLLAMA_BASE_URL", "http://127.0.0.1:11434");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "ollama-response",
      created: 1,
      model: "qwen-test",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await invokeLLM({ provider: "ollama", messages: [{ role: "user", content: "Analyze locally" }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(init.headers).not.toHaveProperty("authorization");
    expect(init.redirect).toBe("error");

    vi.stubEnv("LARO_OLLAMA_BASE_URL", "https://remote.example.com");
    await expect(invokeLLM({ provider: "ollama", messages: [{ role: "user", content: "Do not send" }] }))
      .rejects.toThrow("LARO_OLLAMA_MODEL is not configured");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes OpenAI-compatible requests only to the selected provider", async () => {
    vi.stubEnv("GROQ_API_KEY", "test-groq-key");
    vi.stubEnv("LARO_GROQ_MODEL", "test-model");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "response-1",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await invokeLLM({
      provider: "groq",
      messages: [{ role: "user", content: "Analyze" }],
      response_format: { type: "json_object" },
      max_tokens: 123,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.headers).toMatchObject({ authorization: "Bearer test-groq-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "test-model",
      max_tokens: 123,
      response_format: { type: "json_object" },
    });
  });

  it("uses OpenAI's current completion-token field", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "response-openai",
      created: 1,
      model: "gpt-test",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await invokeLLM({
      provider: "openai",
      messages: [{ role: "user", content: "Analyze" }],
      max_tokens: 456,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.max_completion_tokens).toBe(456);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("uses Together's current endpoint and preserves JSON Schema output", async () => {
    vi.stubEnv("TOGETHER_API_KEY", "test-together-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "response-together",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await invokeLLM({
      provider: "together",
      messages: [{ role: "user", content: "Analyze" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", schema: { type: "object" } },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.together.ai/v1/chat/completions");
    expect(JSON.parse(String(init.body)).response_format.type).toBe("json_schema");
  });

  it("normalizes Anthropic Messages responses to the shared result contract", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "msg-1",
      model: "claude-test",
      content: [{ type: "text", text: '{"answer":"grounded"}' }],
      stop_reason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 7 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeLLM({
      provider: "anthropic",
      messages: [
        { role: "system", content: "Use the evidence." },
        { role: "user", content: "Question" },
      ],
      response_format: { type: "json_object" },
    });

    expect(result.choices[0].message.content).toBe('{"answer":"grounded"}');
    expect(result.usage).toEqual({ prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "x-api-key": "test-anthropic-key", "anthropic-version": "2023-06-01" });
    const body = JSON.parse(String(init.body));
    expect(body.system).toContain("Use the evidence.");
    expect(body.system).toContain("valid JSON object");
    expect(body.messages).toEqual([{ role: "user", content: "Question" }]);
  });

  it("fails closed when the selected provider is not configured", async () => {
    vi.stubEnv("TOGETHER_API_KEY", "");
    await expect(invokeLLM({
      provider: "together",
      messages: [{ role: "user", content: "Analyze" }],
    })).rejects.toThrow("TOGETHER_API_KEY is not configured");
  });
});
