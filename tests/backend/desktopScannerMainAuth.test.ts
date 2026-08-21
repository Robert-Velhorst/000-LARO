import { describe, expect, it, vi } from "vitest";
import { getDesktopScannerAuth } from "../../src-main/scannerAuth";

describe("desktop scanner main-process session resolution", () => {
  it("resolves the exact LARO session cookie without exposing extra cookies", async () => {
    const get = vi.fn().mockResolvedValue([
      { name: "other", value: "ignore" },
      { name: "laro_session", value: "http-only-session" },
    ]);
    const scannerSecret = "s".repeat(43);

    await expect(getDesktopScannerAuth({
      apiUrl: "http://127.0.0.1:8768",
      scannerSecret,
      cookieStore: { get },
    })).resolves.toEqual({
      sessionCookie: "laro_session=http-only-session",
      scannerSecret,
    });
    expect(get).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8768",
      name: "laro_session",
    });
  });

  it("fails closed without a current browser session", async () => {
    await expect(getDesktopScannerAuth({
      apiUrl: "http://127.0.0.1:8768",
      scannerSecret: "s".repeat(43),
      cookieStore: { get: vi.fn().mockResolvedValue([]) },
    })).rejects.toThrow("Sign in to LARO");
  });

  it("fails before reading cookies when the launch proof is unavailable", async () => {
    const get = vi.fn();
    await expect(getDesktopScannerAuth({
      apiUrl: "http://127.0.0.1:8768",
      scannerSecret: "short",
      cookieStore: { get },
    })).rejects.toThrow("authorization is unavailable");
    expect(get).not.toHaveBeenCalled();
  });
});
