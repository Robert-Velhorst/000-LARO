import { afterEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { DESKTOP_SCANNER_HEADER } from "../../shared/desktopScannerAuth";
import { isDesktopScannerRequest } from "../../server/desktopScannerAuth";
import { createContext } from "../../server/context";
import { ENV } from "../../server/_core/env";

function request(secret: string | undefined, remoteAddress = "127.0.0.1") {
  return {
    headers: secret ? { [DESKTOP_SCANNER_HEADER]: secret } : {},
    socket: { remoteAddress },
    get(name: string) {
      return this.headers[name.toLowerCase() as keyof typeof this.headers];
    },
  } as any;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("desktop scanner main-process proof", () => {
  it("accepts an exact per-launch secret from loopback", () => {
    const secret = "s".repeat(43);
    vi.stubEnv("LARO_DESKTOP_SCANNER_SECRET", secret);
    expect(isDesktopScannerRequest(request(secret))).toBe(true);
    expect(isDesktopScannerRequest(request(secret, "::ffff:127.0.0.1"))).toBe(true);
    expect(isDesktopScannerRequest(request(secret, "::1"))).toBe(true);
  });

  it("rejects absent, short, or mismatched proofs", () => {
    vi.stubEnv("LARO_DESKTOP_SCANNER_SECRET", "s".repeat(43));
    expect(isDesktopScannerRequest(request(undefined))).toBe(false);
    expect(isDesktopScannerRequest(request("wrong"))).toBe(false);
    vi.stubEnv("LARO_DESKTOP_SCANNER_SECRET", "short");
    expect(isDesktopScannerRequest(request("short"))).toBe(false);
  });

  it("rejects a valid proof from a non-loopback peer", () => {
    const secret = "s".repeat(43);
    vi.stubEnv("LARO_DESKTOP_SCANNER_SECRET", secret);
    expect(isDesktopScannerRequest(request(secret, "203.0.113.10"))).toBe(false);
  });

  it("rejects previously minted JWT bearer credentials", async () => {
    const token = jwt.sign({ userId: "legacy-user", scope: "evidence-scanner" }, ENV.JWT_SECRET);
    const req = request(undefined);
    req.headers.authorization = `Bearer ${token}`;
    req.cookies = {};
    const context = await createContext({ req, res: {} as any });
    expect(context.user).toBeNull();
    expect(context.desktopScanner).toBe(false);
  });
});
