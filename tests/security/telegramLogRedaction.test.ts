import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeErrorForLogging } from "../../server/errorHandler";
import {
  downloadTelegramFile,
  getTelegramBotInfo,
  isValidTelegramToken,
} from "../../server/telegramService";
import { MAX_EVIDENCE_FILE_BYTES } from "../../shared/evidenceFiles";

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

  it("rejects oversized bot tokens before constructing a provider URL", () => {
    expect(isValidTelegramToken(`123456789:${"a".repeat(256)}`)).toBe(false);
  });

  it("bounds Telegram metadata requests by time and response size", async () => {
    const token = "123456789:bounded-token";
    const getMock = vi.spyOn(axios, "get").mockResolvedValue({
      data: { ok: true, result: { id: 1, first_name: "LARO" } },
    });

    await getTelegramBotInfo(token);

    expect(getMock).toHaveBeenCalledWith(
      expect.stringContaining("/getMe"),
      expect.objectContaining({
        timeout: 20_000,
        maxContentLength: 1_048_576,
      }),
    );
  });

  it("bounds Telegram file downloads by time and evidence-file size", async () => {
    const token = "123456789:bounded-token";
    const getMock = vi.spyOn(axios, "get").mockResolvedValue({ data: Buffer.from("file") });

    await downloadTelegramFile(token, "documents/evidence.pdf");

    expect(getMock).toHaveBeenCalledWith(
      expect.stringContaining("/documents/evidence.pdf"),
      expect.objectContaining({
        responseType: "arraybuffer",
        timeout: 20_000,
        maxContentLength: MAX_EVIDENCE_FILE_BYTES,
      }),
    );
  });
});
