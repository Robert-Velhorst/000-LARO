import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import oauth2CallbacksRouter from "../../server/oauth2Callbacks";

describe("OAuth callback response", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("returns a closeable, opener-compatible page without leaking callback details", async () => {
    const app = express();
    app.use(oauth2CallbacksRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to TCP");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/oauth/gmail/callback`);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("unsafe-none");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[^']+'/);
    expect(body).toContain("window.opener.postMessage");
    expect(body).toContain("window.close()");
    expect(body).not.toContain("code=");
    expect(body).not.toContain("state=");
  });
});
