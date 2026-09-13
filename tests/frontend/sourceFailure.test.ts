import { describe, expect, it } from "vitest";
import { describeSourceFailure, sourceFailureMessage } from "../../shared/sourceFailure";

describe("source failure explanations", () => {
  it.each([
    ["EACCES", "file_access"], ["ENOENT", "file_missing"], ["ENOSPC", "storage_full"],
    ["Document extraction exceeded the 5 minute processing limit", "timeout"],
    ["ECONNREFUSED", "connection"], ["Google source request failed (HTTP 403)", "google_access"],
    ["Google source request failed (HTTP 429)", "rate_limit"], ["PDF requires OCR for more than 30 pages", "resource_limit"],
    ["Invalid PDF structure", "unreadable"], ["ollama is selected but not configured", "model_unconfigured"],
  ])("classifies %s", (message, code) => {
    expect(describeSourceFailure(message).code).toBe(code);
    expect(describeSourceFailure(sourceFailureMessage(message)).code).toBe(code);
  });
  it("uses errno without exposing exception contents", () => {
    const message = sourceFailureMessage(Object.assign(new Error("SECRET source text bearer abc"), { code: "EACCES" }));
    expect(message).toContain("file_access");
    expect(message).not.toContain("SECRET");
    expect(message).not.toContain("abc");
  });
  it("does not invent the cause of an unknown or old generic failure", () => {
    expect(describeSourceFailure("Source work failed").code).toBe("unknown");
    expect(sourceFailureMessage(new Error("https://private.example/?token=secret"))).not.toContain("secret");
    expect(describeSourceFailure("https://private.example/?password=secret").code).toBe("unknown");
  });
});
