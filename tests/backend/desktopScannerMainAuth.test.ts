import { describe, expect, it, vi } from "vitest";
import {
  createDesktopScannerHeaders,
  getDesktopScannerAuth,
} from "../../src-main/scannerAuth";

describe("desktop scanner main-process session resolution", () => {
  it("resolves the exact LARO session cookie without exposing extra cookies", async () => {
    const get = vi.fn().mockResolvedValue([
      { name: "other", value: "ignore" },
      { name: "laro_session", value: "http-only-session" },
    ]);
    const scannerSecret = "s".repeat(43);

    await expect(getDesktopScannerAuth({
      cookieUrl: "http://localhost:5173/?mode=scanner",
      scannerSecret,
      cookieStore: { get },
    })).resolves.toEqual({
      sessionCookie: "laro_session=http-only-session",
      scannerSecret,
    });
    expect(get).toHaveBeenCalledWith({
      url: "http://localhost:5173/?mode=scanner",
      name: "laro_session",
    });
  });

  it("resolves the current browser session for every upload batch", async () => {
    const resolveAuth = vi.fn()
      .mockResolvedValueOnce({
        sessionCookie: "laro_session=active-session",
        scannerSecret: "s".repeat(43),
      })
      .mockRejectedValueOnce(new Error("Sign in to LARO before uploading evidence"));
    const headers = createDesktopScannerHeaders(resolveAuth);

    await expect(headers()).resolves.toEqual({
      Cookie: "laro_session=active-session",
      "x-laro-desktop-scanner": "s".repeat(43),
    });
    await expect(headers()).rejects.toThrow("Sign in to LARO");
    expect(resolveAuth).toHaveBeenCalledTimes(2);
  });

  it("fails closed without a current browser session", async () => {
    await expect(getDesktopScannerAuth({
      cookieUrl: "http://localhost:5173/?mode=scanner",
      scannerSecret: "s".repeat(43),
      cookieStore: { get: vi.fn().mockResolvedValue([]) },
    })).rejects.toThrow("Sign in to LARO");
  });

  it("fails before reading cookies when the launch proof is unavailable", async () => {
    const get = vi.fn();
    await expect(getDesktopScannerAuth({
      cookieUrl: "http://localhost:5173/?mode=scanner",
      scannerSecret: "short",
      cookieStore: { get },
    })).rejects.toThrow("authorization is unavailable");
    expect(get).not.toHaveBeenCalled();
  });
});
