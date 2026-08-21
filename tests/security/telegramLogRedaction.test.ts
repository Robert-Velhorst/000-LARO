import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeErrorForLogging } from "../../server/errorHandler";
import { getTelegramBotInfo } from "../../server/telegramService";

describe("Telegram credential redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts bot tokens embedded in Telegram API URL paths", () => {
    const token = "123456789:SENTINEL_BOT_TOKEN";
    const sanitized = sanitizeErrorForLogging(new Error(
      `GET https://api.telegram.org/bot${token}/getMe and ` +
      `https://api.telegram.org/file/bot${token}/documents/file.pdf failed`,
    ));

    expect(sanitized).not.toContain(token);
    expect(sanitized).toContain("/bot***/getMe");
    expect(sanitized).toContain("/file/bot***/documents/file.pdf");
  });

  it("logs only bounded provider metadata and never propagates raw Axios details", async () => {
    const token = "123456789:SENTINEL_BOT_TOKEN";
    const providerError = Object.assign(
      new Error(`GET https://api.telegram.org/bot${token}/getMe failed`),
      {
        isAxiosError: true,
        config: { url: `https://api.telegram.org/bot${token}/getMe` },
        response: {
          status: 401,
          data: { ok: false, error_code: 401, description: `Rejected ${token}` },
        },
      },
    );
    vi.spyOn(axios, "get").mockRejectedValue(providerError);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(getTelegramBotInfo(token)).rejects.toThrow("Telegram bot information request failed");

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith("[Telegram] Operation failed", {
      operation: "getBotInfo",
      status: 401,
      providerCode: 401,
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(token);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("api.telegram.org");
  });
});
