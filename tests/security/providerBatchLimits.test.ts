import { describe, expect, it } from "vitest";
import {
  ProviderBatchBudget,
  ProviderBatchLimitError,
} from "../../server/providerLimits";

describe("provider batch budgets", () => {
  it("tracks aggregate work across multiple provider pages", () => {
    const budget = new ProviderBatchBudget({ files: 3, pages: 2 });
    budget.consume("files", 2);
    budget.consume("files", 1);
    expect(() => budget.consume("files", 1)).toThrow(ProviderBatchLimitError);
    expect(budget.used("files")).toBe(3);
  });

  it("rejects unsafe or unknown budget consumption", () => {
    const budget = new ProviderBatchBudget({ files: 3 });
    expect(() => budget.consume("files", -1)).toThrow("non-negative safe integer");
    expect(() => budget.consume("pages" as "files", 1)).toThrow("not configured");
  });
});
