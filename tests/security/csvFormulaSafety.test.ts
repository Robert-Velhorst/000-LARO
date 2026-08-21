import { describe, expect, it } from "vitest";
import { encodeCsvCell, encodeCsvRows } from "../../shared/csv";

describe("CSV spreadsheet formula safety", () => {
  it.each([
    ["=1+1", "'=1+1"],
    ["+cmd", "'+cmd"],
    ["-2", "'-2"],
    ["@SUM(A1:A2)", "'@SUM(A1:A2)"],
    ["\t=1+1", "'\t=1+1"],
    ["\r=1+1", '"\'\r=1+1"'],
    ["\n=1+1", '"\'\n=1+1"'],
    ["  =1+1", "'  =1+1"],
  ])("neutralizes dangerous spreadsheet cell %j", (input, expected) => {
    expect(encodeCsvCell(input)).toBe(expected);
  });

  it("preserves ordinary values while applying RFC-style CSV quoting", () => {
    expect(encodeCsvCell("ordinary text")).toBe("ordinary text");
    expect(encodeCsvCell(-2)).toBe("-2");
    expect(encodeCsvCell("-2")).toBe("'-2");
    expect(encodeCsvCell('legal, "quoted" text')).toBe('"legal, ""quoted"" text"');
    expect(encodeCsvRows([["title", "value"], ["safe", "=unsafe"]], "\n"))
      .toBe("title,value\nsafe,'=unsafe");
  });
});
