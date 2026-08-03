import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV } from "../../server/_core/env";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { standaloneSignupAllowed } from "../../server/signupPolicy";

const suite = sqliteAvailable ? describe : describe.skip;
const BOOTSTRAP_TOKEN = "standalone-owner-bootstrap-token-32";

describe("standalone signup policy", () => {
  it("requires a strong matching token and an empty user table", () => {
    expect(standaloneSignupAllowed({
      serverOnly: true,
      existingUserCount: 0,
      expectedBootstrapToken: BOOTSTRAP_TOKEN,
      suppliedBootstrapToken: BOOTSTRAP_TOKEN,
    })).toBe(true);
    expect(standaloneSignupAllowed({
      serverOnly: true,
      existingUserCount: 0,
      expectedBootstrapToken: BOOTSTRAP_TOKEN,
      suppliedBootstrapToken: "standalone-owner-bootstrap-token-no",
    })).toBe(false);
    expect(standaloneSignupAllowed({
      serverOnly: true,
      existingUserCount: 1,
      expectedBootstrapToken: BOOTSTRAP_TOKEN,
      suppliedBootstrapToken: BOOTSTRAP_TOKEN,
    })).toBe(false);
    expect(standaloneSignupAllowed({
      serverOnly: false,
      existingUserCount: 10,
    })).toBe(true);
  });
});

suite("standalone signup integration", () => {
  let app: TestApp;
  const originalServerOnly = ENV.SERVER_ONLY;
  const originalBootstrapToken = ENV.STANDALONE_SIGNUP_TOKEN;

  beforeAll(async () => {
    app = await bootTestApp();
    ENV.SERVER_ONLY = true;
    ENV.STANDALONE_SIGNUP_TOKEN = BOOTSTRAP_TOKEN;
  });

  afterAll(() => {
    ENV.SERVER_ONLY = originalServerOnly;
    ENV.STANDALONE_SIGNUP_TOKEN = originalBootstrapToken;
    app?.cleanup();
  });

  it("rejects an unauthorised first claim without creating an account", async () => {
    await expect(app.makeCaller(null).auth.signup({
      email: "attacker@example.com",
      password: "not-the-owner-password",
      name: "Attacker",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await app.db.select().from(app.schema.users)).toHaveLength(0);
  });

  it("atomically creates one administrator from concurrent valid claims", async () => {
    const claims = await Promise.allSettled([
      app.makeCaller(null).auth.signup({
        email: "owner@example.com",
        password: "owner-password-123",
        name: "Owner",
        bootstrapToken: BOOTSTRAP_TOKEN,
      }),
      app.makeCaller(null).auth.signup({
        email: "other-owner@example.com",
        password: "other-owner-password-123",
        name: "Other Owner",
        bootstrapToken: BOOTSTRAP_TOKEN,
      }),
    ]);

    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);

    const users = await app.db.select().from(app.schema.users);
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe("admin");
    expect(["owner@example.com", "other-owner@example.com"]).toContain(users[0].email);

    await expect(app.makeCaller(null).auth.signup({
      email: "second@example.com",
      password: "second-password-123",
      name: "Second",
      bootstrapToken: BOOTSTRAP_TOKEN,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await app.db.select().from(app.schema.users)).toHaveLength(1);
  });

  it("preserves normal multi-account signup in the desktop runtime", async () => {
    ENV.SERVER_ONLY = false;
    await expect(app.makeCaller(null).auth.signup({
      email: "desktop@example.com",
      password: "desktop-password-123",
      name: "Desktop User",
    })).resolves.toMatchObject({ success: true });

    const desktopUser = (await app.db.select().from(app.schema.users))
      .find((user: any) => user.email === "desktop@example.com");
    expect(desktopUser).toMatchObject({ role: "user" });
  });
});
