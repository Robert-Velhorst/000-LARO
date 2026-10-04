import { once } from "node:events";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendSystemEmail, verifyOutboundEmailConnection } from "../../server/systemEmail";

// Exercise the installed Nodemailer against a loopback SMTP peer. No provider
// account, external recipient, or real credential is used by these tests.
const cleanup: Array<() => Promise<void>> = [];

async function smtpPeer(options: { rejectAuth?: boolean; rejectRecipient?: boolean } = {}) {
  const messages: string[] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { /* Transport failures are asserted by the caller. */ });
    socket.setEncoding("utf8");
    socket.write("220 loopback.example.test ESMTP\r\n");
    let buffer = "";
    let message: string[] | null = null;
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (message) {
          if (line === ".") {
            messages.push(message.join("\r\n"));
            message = null;
            socket.write("250 2.0.0 accepted\r\n");
          } else {
            message.push(line);
          }
          continue;
        }
        const verb = line.split(" ", 1)[0].toUpperCase();
        commands.push(verb);
        switch (verb) {
          case "EHLO":
          case "HELO":
            socket.write("250-loopback.example.test\r\n250 AUTH PLAIN\r\n");
            break;
          case "AUTH":
            socket.write(options.rejectAuth ? "535 5.7.8 rejected\r\n" : "235 2.7.0 authenticated\r\n");
            break;
          case "MAIL":
            socket.write("250 2.1.0 sender accepted\r\n");
            break;
          case "RCPT":
            socket.write(options.rejectRecipient ? "550 5.1.1 rejected\r\n" : "250 2.1.5 recipient accepted\r\n");
            break;
          case "DATA":
            message = [];
            socket.write("354 End with dot\r\n");
            break;
          case "QUIT":
            socket.end("221 2.0.0 bye\r\n");
            break;
          case "STARTTLS":
            socket.write("454 4.7.0 TLS unavailable\r\n");
            break;
          default:
            socket.write("500 unsupported command\r\n");
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  const port = (server.address() as AddressInfo).port;
  vi.stubEnv("SENDGRID_API_KEY", "");
  vi.stubEnv("EMAIL_PROVIDER", "smtp");
  vi.stubEnv("SMTP_HOST", "127.0.0.1");
  vi.stubEnv("SMTP_PORT", String(port));
  vi.stubEnv("SMTP_USER", "loopback@example.test");
  vi.stubEnv("SMTP_PASS", "loopback-test-only");
  vi.stubEnv("SMTP_FROM", "loopback@example.test");
  // Plain SMTP is allowed only for this loopback fixture. The TLS test below
  // verifies the application's default still rejects a non-TLS peer.
  vi.stubEnv("SMTP_STARTTLS", "false");
  return { messages, commands };
}

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllEnvs();
});

const email = {
  to: "recipient@example.test",
  subject: "Local transport upgrade regression",
  text: "This synthetic message never leaves the loopback SMTP fixture.",
};

describe("SMTP transport compatibility", () => {
  it("authenticates, verifies the connection, and delivers exactly one message", async () => {
    const peer = await smtpPeer();
    await expect(verifyOutboundEmailConnection()).resolves.toEqual({ ok: true, provider: "smtp" });
    expect(peer.messages).toEqual([]);
    await expect(sendSystemEmail(email)).resolves.toMatchObject({
      delivered: true, provider: "smtp", providerMessageId: expect.any(String),
    });
    expect(peer.commands.filter((command) => command === "AUTH")).toHaveLength(2);
    expect(peer.messages).toHaveLength(1);
    expect(peer.messages[0]).toContain(`To: ${email.to}`);
    expect(peer.messages[0]).toContain(`Subject: ${email.subject}`);
    expect(peer.messages[0]).toContain(email.text);
  });

  it("does not report delivery after authentication fails", async () => {
    const peer = await smtpPeer({ rejectAuth: true });
    await expect(sendSystemEmail(email)).rejects.toMatchObject({ code: "EAUTH" });
    expect(peer.messages).toEqual([]);
    expect(peer.commands).not.toContain("DATA");
  });

  it("does not report delivery when the recipient is rejected", async () => {
    const peer = await smtpPeer({ rejectRecipient: true });
    await expect(sendSystemEmail(email)).rejects.toMatchObject({ code: "EENVELOPE" });
    expect(peer.messages).toEqual([]);
    expect(peer.commands).not.toContain("DATA");
  });

  it("requires STARTTLS by default before disclosing credentials or message data", async () => {
    const peer = await smtpPeer();
    vi.stubEnv("SMTP_STARTTLS", undefined);
    await expect(sendSystemEmail(email)).rejects.toMatchObject({ code: "ETLS" });
    expect(peer.commands).toContain("STARTTLS");
    expect(peer.commands).not.toContain("AUTH");
    expect(peer.messages).toEqual([]);
  });
});
