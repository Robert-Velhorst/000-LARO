import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dossierDiscoveryCases } from "../tests/evals/dossierDiscovery.cases";
import { dossierDiscoveryChallenge } from "../tests/evals/dossierDiscovery.challenge";
import type { WorkflowPreferences } from "../server/workflowPreferences";

async function main() {
  const { values } = parseArgs({ options: {
    run: { type: "boolean", default: false }, model: { type: "string" }, output: { type: "string" },
    "base-url": { type: "string", default: "http://127.0.0.1:11434" }, limit: { type: "string" },
    suite: { type: "string", default: "regression" },
    "case-id": { type: "string" },
    "reasoning-effort": { type: "string" },
    "timeout-seconds": { type: "string" },
  } });
  if (!values.run) {
    console.log("Local synthetic discovery evaluation. No private files, database writes or cloud calls.\nRun: npm run eval:dossiers -- --run --model MODEL --output REPORT.json [--base-url http://127.0.0.1:11434] [--suite regression|challenge] [--case-id ID] [--limit N] [--reasoning-effort none|low|medium|high|max] [--timeout-seconds 15..600]");
    return;
  }
  if (!values.model || !values.output) throw new Error("An explicit model and new report path are required");
  const url = new URL(values["base-url"]!);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Only a loopback HTTP origin is allowed");
  }
  if (!["regression", "challenge"].includes(values.suite!)) throw new Error("Invalid evaluation suite");
  const suiteSamples = values.suite === "challenge" ? dossierDiscoveryChallenge : dossierDiscoveryCases;
  const samples = values["case-id"] === undefined ? suiteSamples : suiteSamples.filter(sample => sample.id === values["case-id"]);
  if (!samples.length) throw new Error("Unknown case ID in the selected evaluation suite");
  const limit = values.limit === undefined ? samples.length : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > samples.length) throw new Error("Invalid sample limit");
  const reasoningEffort = values["reasoning-effort"] ?? (process.env.LARO_OLLAMA_REASONING_EFFORT || "").trim();
  if (reasoningEffort && !["none", "low", "medium", "high", "max"].includes(reasoningEffort)) throw new Error("Invalid reasoning effort");
  process.env.LARO_OLLAMA_REASONING_EFFORT = reasoningEffort;
  process.env.LARO_OLLAMA_BASE_URL = url.origin;
  process.env.LARO_OLLAMA_MODEL = values.model;
  if (values["timeout-seconds"] !== undefined) process.env.LARO_DOSSIER_DISCOVERY_TIMEOUT_SECONDS = values["timeout-seconds"];
  const { discoverDossier, discoveryTimeoutMs } = await import("../server/dossierDiscovery");
  const timeoutMs = discoveryTimeoutMs();
  const { readBoundedResponseJson, readBoundedResponseText } = await import("../server/boundedHttpResponse");
  const get = async (path: string) => {
    const response = await fetch(`${url.origin}${path}`, { signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!response.ok) throw new Error(`Local model metadata failed: HTTP ${response.status}`);
    return readBoundedResponseJson<any>(response, { maxBytes: 1024 * 1024, label: "Local model metadata" });
  };
  const tags = await get("/api/tags");
  const model = tags.models.find((item: any) => item.name === values.model);
  if (!model) throw new Error("The requested model is not already installed; this script never downloads models");
  const report = { schemaVersion: 1, scope: "synthetic_discovery_decisions_only", productionAccepted: false,
    startedAt: new Date().toISOString(), finishedAt: null as string | null, status: "running",
    model, runtime: await get("/api/version"), origin: url.origin, suite: values.suite, selectedCaseId: values["case-id"] ?? null,
    requestedSamples: limit, reasoningEffort: reasoningEffort || "provider_default", timeoutMs,
    results: [] as Array<Record<string, unknown>>, exactMatches: 0, nonmatchingAutomaticDecisions: 0,
    expectedAutomaticDecisions: 0, correctAutomaticDecisions: 0, requiredReviews: 0, correctReviews: 0 };
  const output = resolve(values.output);
  await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
  const { analyzeDocumentBytes } = await import("../server/documentIntelligence");
  const preferences: WorkflowPreferences = { analysisMode: "local", analysisProvider: "ollama",
    autoAnalyzeImports: true, autoOrganizeDocuments: true, shareRawDocumentContent: false,
    externalDocumentSharingConsent: null,
    outreachReviewMode: "each", messageApprovalMode: "each" };
  const nativeFetch = globalThis.fetch;
  let transport: Array<Record<string, unknown>> = [];
  // Observe real local responses without replacing model output or changing requests.
  globalThis.fetch = async (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!target.startsWith(`${url.origin}/`)) throw new Error("Evaluation blocked a non-local request");
    const observation: Record<string, unknown> = { target, startedAt: new Date().toISOString() };
    if (target.endsWith("/v1/chat/completions")) {
      observation.request = JSON.parse(String(init?.body));
      transport.push(observation);
    }
    try {
      const response = await nativeFetch(input, init);
      observation.status = response.status;
      if (target.endsWith("/v1/chat/completions")) {
        const body = await readBoundedResponseText(response.clone(), { maxBytes: 1024 * 1024, label: "Synthetic evaluation response" });
        observation.body = JSON.parse(body);
      }
      return response;
    } catch (error) {
      observation.error = error instanceof Error ? `${error.name}: ${error.message}` : "Request failed";
      if (error instanceof Error && error.cause instanceof Error) {
        observation.cause = { name: error.cause.name, message: error.cause.message,
          code: "code" in error.cause ? String(error.cause.code) : null };
      }
      if (!transport.includes(observation)) transport.push(observation);
      throw error;
    } finally {
      observation.finishedAt = new Date().toISOString();
    }
  };
  try {
    for (const sample of samples.slice(0, limit)) {
      transport = [];
      const start = performance.now();
      const analysis = await analyzeDocumentBytes({ bytes: Buffer.from(sample.source), mimeType: "text/plain", deepAnalysis: false });
      const decision = await discoverDossier({ ownerId: "LOCAL-EVALUATION", analysis, sourceText: sample.source, cases: sample.cases, preferences });
      const exact = decision.action === sample.expectedAction && decision.caseId === sample.expectedCaseId;
      if (exact) report.exactMatches++;
      else if (decision.action !== "review") report.nonmatchingAutomaticDecisions++;
      if (sample.expectedAction === "review") {
        report.requiredReviews++;
        if (exact) report.correctReviews++;
      } else {
        report.expectedAutomaticDecisions++;
        if (exact) report.correctAutomaticDecisions++;
      }
      report.results.push({ ...sample, decision, exact, elapsedMs: Math.round(performance.now() - start),
        extractionCoverage: analysis.coverage, citationCount: analysis.citations.length, transport, runtimeState: await get("/api/ps") });
      await writeFile(output, JSON.stringify(report, null, 2));
      console.log(`${sample.id}: ${decision.action} (${exact ? "expected" : "not expected"}), ${report.results.at(-1)!.elapsedMs} ms`);
    }
    report.status = "complete";
    if (report.exactMatches !== limit) process.exitCode = 2;
  } catch (error) {
    report.status = "failed";
    report.results.push({ error: error instanceof Error ? error.message : "Evaluation failed", transport });
    process.exitCode = 1;
  } finally {
    globalThis.fetch = nativeFetch;
    report.finishedAt = new Date().toISOString();
    await writeFile(output, JSON.stringify(report, null, 2));
  }
  console.log(`Report: ${output}; exact matches ${report.exactMatches}/${limit}; production acceptance remains false.`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Evaluation failed"); process.exitCode = 1; });
