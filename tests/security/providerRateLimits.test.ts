import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { MAX_EVIDENCE_FILE_BYTES } from "../../shared/evidenceFiles";

const { trelloConnectionMock, telegramBotInfoMock } = vi.hoisted(() => ({
  trelloConnectionMock: vi.fn().mockResolvedValue({ ok: true, member: { id: "member", fullName: "Owner" } }),
  telegramBotInfoMock: vi.fn().mockResolvedValue({ id: 1, first_name: "LARO", username: "laro_bot" }),
}));

vi.mock("../../server/trelloService", () => ({
  getTrelloBoards: vi.fn().mockResolvedValue([]),
  getTrelloLists: vi.fn().mockResolvedValue([]),
  getTrelloCards: vi.fn().mockResolvedValue([]),
  testTrelloConnection: trelloConnectionMock,
  syncTrelloForCase: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../server/telegramService", () => ({
  getTelegramFile: vi.fn(),
  downloadTelegramFile: vi.fn(),
  getTelegramBotInfo: telegramBotInfoMock,
  setTelegramWebhook: vi.fn(),
  removeTelegramWebhook: vi.fn(),
  importTelegramExport: vi.fn(),
  isValidTelegramToken: vi.fn().mockReturnValue(true),
}));

const suite = sqliteAvailable ? describe : describe.skip;

suite("provider operation limits", () => {
  let app: TestApp;
  const owner = { id: "PROVIDER_LIMIT_OWNER", role: "user", email: "provider-limit@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
  });

  afterAll(() => app?.cleanup());

  it("persistently limits repeated Trello provider calls per user", async () => {
    const caller = app.makeCaller(owner).trelloEnhanced;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await expect(caller.testConnection({ token: "trello-token" })).resolves.toMatchObject({ success: true });
    }
    await expect(caller.testConnection({ token: "trello-token" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(trelloConnectionMock).toHaveBeenCalledTimes(30);
  });

  it("persistently limits repeated Telegram provider calls per user", async () => {
    const caller = app.makeCaller(owner).telegramEnhanced;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await expect(caller.validateToken({ token: "123456789:telegram-token" })).resolves.toMatchObject({ valid: true });
    }
    await expect(caller.validateToken({ token: "123456789:telegram-token" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(telegramBotInfoMock).toHaveBeenCalledTimes(30);
  });

  it("reports the same Telegram download ceiling that the service enforces", async () => {
    const limits = await app.makeCaller(owner).telegramEnhanced.getLimitations();
    const fileLimit = limits.limitations.find((item: { title: string }) => item.title === "File Size Limit");
    expect(fileLimit?.description).toContain(`${MAX_EVIDENCE_FILE_BYTES / (1024 * 1024)} MB`);
    expect(JSON.stringify(limits)).not.toContain("Implement request queuing and rate limiting");
  });
});
