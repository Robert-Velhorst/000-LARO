import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { invokeLLM } from "../../server/llm";
import { resetLLMUsageBudgetForTests } from "../../server/llmUsageBudget";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("non-sensitive model usage telemetry", () => {
  let app: TestApp;
  const owner = { id: "LLM_TELEMETRY_OWNER", email: "llm-telemetry@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser(owner));
    await app.db.insert(app.schema.cases).values(buildCase({ id: "TELEMETRY_CASE", userId: owner.id }));
  });

  afterEach(() => {
    resetLLMUsageBudgetForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => app?.cleanup());

  it("records operation, provider class, quantity and outcome without prompt text or secrets", async () => {
    await app.makeCaller({ id: owner.id, email: owner.email, role: "user" })
      .gdpr.updateConsent({ analytics: true, expectedUserId: owner.id });
    vi.stubEnv("GROQ_API_KEY", "TOP_SECRET_PROVIDER_KEY");
    vi.stubEnv("LARO_GROQ_MODEL", "telemetry-test-model");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "telemetry-response",
      created: 1,
      model: "telemetry-test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await invokeLLM({
      provider: "groq",
      budget: { ownerId: owner.id, operation: "case_assistant", caseId: "TELEMETRY_CASE" },
      messages: [{ role: "user", content: "PRIVATE_SOURCE_MARKER must never enter telemetry" }],
    });
    await expect(invokeLLM({
      provider: "groq",
      budget: { ownerId: owner.id, operation: "hybrid_search" },
      messages: [{ role: "user", content: "PRIVATE_REJECTED_MARKER".repeat(700) }],
      max_tokens: 300,
    })).rejects.toMatchObject({ limit: "operationInput" });

    const rows = await app.db.select().from(app.schema.usageTracking)
      .where(eq(app.schema.usageTracking.userId, owner.id));
    expect(rows).toHaveLength(2);
    const parsedRows = rows.map((row: typeof rows[number]) => ({ row, metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown> }));
    const success = parsedRows.find((item) => item.metadata.outcome === "success")!;
    const rejected = parsedRows.find((item) => item.metadata.outcome === "budget_rejected")!;
    expect(success.row).toMatchObject({
      resourceType: "ai_model_invocation",
      quantity: 12,
      caseId: "TELEMETRY_CASE",
    });
    expect(success.metadata).toMatchObject({
      operation: "case_assistant",
      providerClass: "external",
      outcome: "success",
      promptTokens: 8,
      completionTokens: 4,
      totalTokens: 12,
      quantityUnit: "tokens",
    });
    expect(rejected.metadata).toMatchObject({
      operation: "hybrid_search",
      providerClass: "external",
      outcome: "budget_rejected",
      quantityUnit: "invocation",
    });
    const persisted = JSON.stringify(rows);
    expect(persisted).not.toContain("PRIVATE_SOURCE_MARKER");
    expect(persisted).not.toContain("PRIVATE_REJECTED_MARKER");
    expect(persisted).not.toContain("TOP_SECRET_PROVIDER_KEY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
