import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildLawyer, buildUser } from "../factories";

const suite = sqliteAvailable ? describe : describe.skip;

suite("Inbound outreach reply correlation", () => {
  let app: TestApp;
  const userId = "INBOUND_OWNER";

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: userId }));
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({ id: "INBOUND_LAWYER", email: "reply@law.example" }),
      buildLawyer({ id: "INBOUND_LAWYER_SHARED", email: "reply@law.example" }),
    ]);
    await app.db.insert(app.schema.cases).values(buildCase({ id: "INBOUND_CASE", userId }));
  });

  afterAll(() => app?.cleanup());

  it("links an exact provider-thread reply once without guessing its legal outcome", async () => {
    await app.db.insert(app.schema.outreachStatus).values({
      id: "INBOUND_OUTREACH",
      caseId: "INBOUND_CASE",
      lawyerId: "INBOUND_LAWYER_SHARED",
      status: "Sent",
      initialContact: new Date("2026-08-10T10:00:00Z"),
      metadata: JSON.stringify({
        outboundProviderMessageId: "<outbound-123@example.com>",
        outboundRecipient: "reply@law.example",
        outboundSubject: "Legal assistance enquiry - employment",
      }),
      createdAt: new Date("2026-08-10T10:00:00Z"),
      updatedAt: new Date("2026-08-10T10:00:00Z"),
    } as any);
    const { linkInboundOutreachReply } = await import("../../server/inboundOutreach");
    const message = {
      gmailMessageId: "gmail-inbound-1",
      gmailThreadId: "gmail-thread-1",
      from: "Lawyer Name <reply@law.example>",
      subject: "Re: Legal assistance enquiry - employment",
      body: "I have reviewed the request. Please call my office.",
      receivedAt: new Date("2026-08-10T13:30:00Z"),
      inReplyTo: "<outbound-123@example.com>",
    };
    expect(await linkInboundOutreachReply({ userId, caseId: "INBOUND_CASE", message })).toEqual({
      status: "linked",
      outreachId: "INBOUND_OUTREACH",
    });
    expect(await linkInboundOutreachReply({ userId, caseId: "INBOUND_CASE", message })).toEqual({
      status: "duplicate",
      outreachId: "INBOUND_OUTREACH",
    });

    const [row] = await app.db.select().from(app.schema.outreachStatus).where(eq(app.schema.outreachStatus.id, "INBOUND_OUTREACH"));
    expect(row.status).toBe("Sent");
    expect(row.responseReceived).toBe("Yes");
    expect(row.responseTimeHours).toBe("3.50");
    expect(JSON.parse(row.metadata || "{}")).toMatchObject({
      inboundGmailMessageIds: ["gmail-inbound-1"],
      responseNeedsClassification: true,
    });
  });

  it("does not link a sender and subject when more than one outreach is a valid candidate", async () => {
    await app.db.insert(app.schema.outreachStatus).values({
      id: "INBOUND_AMBIGUOUS",
      caseId: "INBOUND_CASE",
      lawyerId: "INBOUND_LAWYER",
      status: "Sent",
      initialContact: new Date("2026-08-10T11:00:00Z"),
      metadata: JSON.stringify({
        outboundRecipient: "reply@law.example",
        outboundSubject: "Legal assistance enquiry - employment",
      }),
      createdAt: new Date("2026-08-10T11:00:00Z"),
      updatedAt: new Date("2026-08-10T11:00:00Z"),
    } as any);
    const { linkInboundOutreachReply } = await import("../../server/inboundOutreach");
    const result = await linkInboundOutreachReply({
      userId,
      caseId: "INBOUND_CASE",
      message: {
        gmailMessageId: "gmail-inbound-ambiguous",
        from: "reply@law.example",
        subject: "Re: Legal assistance enquiry - employment",
        body: "Reply",
        receivedAt: new Date("2026-08-10T14:00:00Z"),
      },
    });
    expect(result).toEqual({ status: "ambiguous" });
  });
});
