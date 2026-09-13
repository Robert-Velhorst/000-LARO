import { describe, expect, it } from "vitest";
import { buildCaseReconstruction, type ReconstructionDocument } from "../../server/caseReconstruction";
import { analyzeDocumentBytes } from "../../server/documentIntelligence";

describe("case document reconstruction", () => {
  const record = (id: string, metadata: Record<string, unknown> = {}): ReconstructionDocument => ({
    evidenceId: id, title: id, description: null, source: "gmail", type: "document",
    metadata: JSON.stringify(metadata), createdAt: new Date("2026-09-04T12:00:00Z"), analysis: null,
  });

  it("does not turn import or filesystem timestamps into dates in the case history", () => {
    const result = buildCaseReconstruction({
      documents: [record("unknown", { collectedAt: "2026-09-03", modifiedTime: "2026-09-02" })], events: [],
    });
    expect(result.nodes[0].date).toBe("Undated");
    expect(result.phases).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/undated/i);
  });

  it("rejects impossible calendar dates", () => {
    const result = buildCaseReconstruction({ documents: [record("bad-date", { date: "2026-02-31" })], events: [] });
    expect(result.nodes[0].date).toBe("Undated");
  });

  it("does not present subject-only attachment matches or shared threads as proven replies", () => {
    const result = buildCaseReconstruction({
      documents: [
        record("Decision", { accountId: "account-a", gmailThreadId: "thread", date: "2026-01-01" }),
        record("Later", { accountId: "account-a", gmailThreadId: "thread", date: "2026-01-02" }),
        record("Attachment", { parentSubject: "Decision", date: "2026-01-03" }),
      ], events: [],
    });
    expect(result.edges.filter((edge) => edge.evidence === "explicit")).toEqual([]);
    expect(result.edges).toContainEqual(expect.objectContaining({ relationship: "related", evidence: "inferred" }));
  });

  it("scopes provider identity to an account and prefers exact identity over a matching title", () => {
    const result = buildCaseReconstruction({
      documents: [
        record("Wrong account", { accountId: "account-b", gmailMessageId: "message", gmailThreadId: "thread" }),
        record("Right message", { accountId: "account-a", gmailMessageId: "message", gmailThreadId: "thread" }),
        record("Attachment", { accountId: "account-a", gmailMessageId: "message", attachmentId: "part", parentSubject: "Wrong account" }),
      ], events: [],
    });
    expect(result.edges.filter((edge) => edge.relationship === "attachment_of" && edge.evidence === "explicit"))
      .toEqual([expect.objectContaining({ from: "Right message", to: "Attachment" })]);
    expect(result.edges.find((edge) => edge.from === "Wrong account" && edge.to === "Right message" && edge.evidence === "explicit")).toBeUndefined();
  });
  it("builds deterministic source stations and separates explicit from inferred links", async () => {
    const decision = await analyzeDocumentBytes({
      bytes: Buffer.from([
        "Van: Gemeente Utrecht",
        "Besluit van 14 juli 2026 over bestuursrecht.",
        "Jan de Vries moet binnen 6 weken bezwaar maken.",
      ].join("\n")),
      mimeType: "text/plain",
      deepAnalysis: false,
    });
    const objection = await analyzeDocumentBytes({
      bytes: Buffer.from([
        "Van: Jan de Vries",
        "Bezwaar van 20 juli 2026 over bestuursrecht.",
        "Dit bezwaar reageert op Besluit gemeente.txt van Gemeente Utrecht.",
      ].join("\n")),
      mimeType: "text/plain",
      deepAnalysis: false,
    });
    const attachment = await analyzeDocumentBytes({
      bytes: Buffer.from("Factuur van 20 juli 2026. Jan de Vries betwist EUR 1.250,00 wegens het besluit."),
      mimeType: "text/plain",
      deepAnalysis: false,
    });

    const result = buildCaseReconstruction({
      documents: [
        {
          evidenceId: "decision",
          title: "Besluit gemeente.txt",
          description: null,
          source: "gmail",
          type: "document",
          metadata: JSON.stringify({ gmailMessageId: "message-1", gmailThreadId: "thread-1" }),
          createdAt: new Date("2026-07-14T09:00:00Z"),
          analysis: decision,
        },
        {
          evidenceId: "objection",
          title: "Bezwaar.txt",
          description: null,
          source: "gmail",
          type: "document",
          metadata: JSON.stringify({ gmailMessageId: "message-2", gmailThreadId: "thread-2" }),
          createdAt: new Date("2026-07-20T09:00:00Z"),
          analysis: objection,
        },
        {
          evidenceId: "attachment",
          title: "factuur.pdf",
          description: "Attachment from email \"Besluit gemeente.txt\"",
          source: "gmail",
          type: "document",
          metadata: JSON.stringify({ gmailMessageId: "message-1", parentSubject: "Besluit gemeente.txt", date: "2026-07-20T10:00:00Z" }),
          createdAt: new Date("2026-07-20T10:00:00Z"),
          analysis: attachment,
        },
        {
          evidenceId: "unanalyzed",
          title: "Foto ontvangstbewijs.jpg",
          description: "Imported image",
          source: "google_drive",
          type: "image",
          metadata: JSON.stringify({ modifiedTime: "2026-07-22T10:00:00Z" }),
          createdAt: new Date("2026-07-22T10:00:00Z"),
          analysis: null,
        },
      ],
      events: [
        { date: "2026-07-14", title: "Besluit", description: "Besluit genomen", actor: "Gemeente Utrecht", category: "legal", source: { evidenceId: "decision" } },
        { date: "2026-07-20", title: "Bezwaar", description: "Bezwaar ingediend", actor: "Jan de Vries", category: "legal", source: { evidenceId: "objection" } },
      ],
    });

    expect(result.schemaVersion).toBe(2);
    expect(result.nodes.map((node) => node.id)).toEqual(["decision", "objection", "attachment", "unanalyzed"]);
    expect(result.nodes.find((node) => node.id === "unanalyzed")).toMatchObject({
      date: "Undated",
      analysisStatus: "missing",
      summary: "Imported image",
    });
    expect(result.nodes.find((node) => node.id === "decision")).toMatchObject({
      participants: expect.arrayContaining(["Gemeente Utrecht"]),
      topics: expect.arrayContaining(["administrative law"]),
      actions: [expect.objectContaining({
        date: "2026-07-14",
        title: "Besluit",
        actor: "Gemeente Utrecht",
      })],
    });
    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "decision", to: "attachment", relationship: "attachment_of", evidence: "explicit", confidence: 1 }),
      expect.objectContaining({ from: "decision", to: "objection", relationship: "references", evidence: "explicit" }),
    ]));
    expect(result.phases).toEqual([
      expect.objectContaining({ documentIds: ["decision", "objection", "attachment"], eventCount: 2 }),
    ]);
    expect(result.chains[0]).toMatchObject({
      documentIds: expect.arrayContaining(["decision", "objection", "attachment"]),
      explicitLinkCount: 2,
    });
    expect(result.keyMoments[0]).toMatchObject({
      documentId: "decision",
      verifiedLinkCount: 2,
      eventCount: 1,
    });
    expect(result.warnings.join(" ")).toContain("not been analyzed");
  });
});
