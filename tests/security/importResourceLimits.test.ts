import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import {
  IMPORT_LIMITS,
  normalizeCaseCsvImport,
  normalizeTelegramExport,
} from "../../server/importLimits";

const suite = sqliteAvailable ? describe : describe.skip;

suite("bounded and atomic bulk imports", () => {
  let app: TestApp;
  const owner = { id: "IMPORT_OWNER", email: "imports@example.test", role: "user" };
  const caseId = "CASE_IMPORT_TELEGRAM";

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser(owner));
    await app.db.insert(app.schema.cases).values(buildCase({ id: caseId, userId: owner.id }));
  });

  afterAll(() => app?.cleanup());

  it("rejects oversized CSV input before parsing", () => {
    const csv = `caseTitle,description\nA,${"x".repeat(IMPORT_LIMITS.csv.maxBytes)}`;
    expect(() => normalizeCaseCsvImport(csv, "cases.csv")).toThrow("2 MB");
  });

  it("rejects structurally amplified CSV and Telegram input", () => {
    const csv = `caseTitle,description\n${Array.from(
      { length: IMPORT_LIMITS.csv.maxColumns + 1 },
      (_, index) => `value${index}`,
    ).join(",")}`;
    expect(() => normalizeCaseCsvImport(csv, "wide.csv")).toThrow("columns");

    const deeplyNested = `${"[".repeat(IMPORT_LIMITS.telegram.maxJsonDepth + 1)}0${"]".repeat(IMPORT_LIMITS.telegram.maxJsonDepth + 1)}`;
    expect(() => normalizeTelegramExport(deeplyNested, "deep.json")).toThrow("nesting depth");

    const richText = Array.from(
      { length: IMPORT_LIMITS.telegram.maxRichTextPartsPerMessage + 1 },
      () => "x",
    );
    const richTextExport = JSON.stringify({
      name: "Chat",
      type: "personal_chat",
      id: 1,
      messages: [{
        id: 1,
        type: "message",
        date: "2026-08-22T10:00:00",
        date_unixtime: "1787392800",
        text: richText,
      }],
    });
    expect(() => normalizeTelegramExport(richTextExport, "rich-text.json"))
      .toThrow("rich-text parts");
  });

  it("uses the preflight CSV delimiter during parsing", () => {
    const semicolonData = Array.from({ length: 25 }, (_, index) => `value${index}`).join(";");
    const normalized = normalizeCaseCsvImport(
      `caseTitle,description\n${semicolonData},Description`,
      "mixed-delimiters.csv",
    );
    expect(normalized.rows[0]).toMatchObject({
      caseTitle: semicolonData,
      description: "Description",
    });
  });

  it("persists import rate limits per user", async () => {
    const { enforcePersistentRateLimit } = await import("../../server/rateLimit");
    const config = { maxRequests: 1, windowMs: 60_000, message: "Import limit reached." };
    const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };

    await expect(enforcePersistentRateLimit({ user: { id: "LIMIT_OWNER_A" }, req }, "test-import", config))
      .resolves.toBeUndefined();
    await expect(enforcePersistentRateLimit({ user: { id: "LIMIT_OWNER_A" }, req }, "test-import", config))
      .rejects.toThrow("Import limit reached");
    await expect(enforcePersistentRateLimit({ user: { id: "LIMIT_OWNER_B" }, req }, "test-import", config))
      .resolves.toBeUndefined();
  });

  it("rejects CSV row overflow before any database mutation", async () => {
    const rows = Array.from(
      { length: IMPORT_LIMITS.csv.maxRows + 1 },
      (_, index) => `Case ${index},Description ${index}`,
    );
    const csv = ["caseTitle,description", ...rows].join("\n");

    await expect(app.makeCaller(owner).bulkImport.uploadCSV({
      csvContent: csv,
      filename: "too-many.csv",
    })).rejects.toThrow(`${IMPORT_LIMITS.csv.maxRows}`);

    const jobs = await app.db.select().from(app.schema.bulkImportJobs)
      .where(eq(app.schema.bulkImportJobs.userId, owner.id));
    expect(jobs).toHaveLength(0);
  });

  it("rolls back the CSV job and all cases when a later insert fails", async () => {
    const sqlite = (app.db as any).$client;
    sqlite.exec(`
      CREATE TRIGGER reject_atomic_csv_case
      BEFORE INSERT ON cases
      WHEN NEW.clientName = 'Reject me'
      BEGIN
        SELECT RAISE(ABORT, 'forced CSV failure');
      END;
    `);

    try {
      await expect(app.makeCaller(owner).bulkImport.uploadCSV({
        csvContent: "caseTitle,description\nKeep me,First row\nReject me,Second row",
        filename: "atomic.csv",
      })).rejects.toThrow("no cases were added");
    } finally {
      sqlite.exec("DROP TRIGGER reject_atomic_csv_case;");
    }

    const importedCases = await app.db.select().from(app.schema.cases)
      .where(eq(app.schema.cases.userId, owner.id));
    const jobs = await app.db.select().from(app.schema.bulkImportJobs)
      .where(eq(app.schema.bulkImportJobs.userId, owner.id));
    expect(importedCases.map((row: any) => row.id)).toEqual([caseId]);
    expect(jobs).toHaveLength(0);
  });

  it("rejects Telegram message overflow and oversized message fields", () => {
    const baseMessage = {
      id: 1,
      type: "message",
      date: "2026-08-22T10:00:00",
      date_unixtime: "1787392800",
      from: "Sender",
      text: "Evidence",
    };
    const overflow = JSON.stringify({
      name: "Chat",
      type: "personal_chat",
      id: 1,
      messages: Array.from(
        { length: IMPORT_LIMITS.telegram.maxMessages + 1 },
        (_, index) => ({ ...baseMessage, id: index + 1 }),
      ),
    });
    expect(() => normalizeTelegramExport(overflow, "result.json"))
      .toThrow(`${IMPORT_LIMITS.telegram.maxMessages}`);

    const oversizedText = JSON.stringify({
      name: "Chat",
      type: "personal_chat",
      id: 1,
      messages: [{ ...baseMessage, text: "x".repeat(IMPORT_LIMITS.telegram.maxMessageTextChars + 1) }],
    });
    expect(() => normalizeTelegramExport(oversizedText, "result.json"))
      .toThrow("message text");
  });

  it("rolls back the Telegram source and all messages when a later insert fails", async () => {
    const sqlite = (app.db as any).$client;
    sqlite.exec(`
      CREATE TRIGGER reject_atomic_telegram_item
      BEFORE INSERT ON evidence_items
      WHEN NEW.title LIKE '%Reject me%'
      BEGIN
        SELECT RAISE(ABORT, 'forced Telegram failure');
      END;
    `);
    const exportJson = JSON.stringify({
      name: "Atomic chat",
      type: "personal_chat",
      id: 99,
      messages: [
        {
          id: 1,
          type: "message",
          date: "2026-08-22T10:00:00",
          date_unixtime: "1787392800",
          from: "Keep me",
          text: "First",
        },
        {
          id: 2,
          type: "message",
          date: "2026-08-22T10:01:00",
          date_unixtime: "1787392860",
          from: "Reject me",
          text: "Second",
        },
      ],
    });

    try {
      await expect(app.makeCaller(owner).telegramEnhanced.importExport({
        caseId,
        fileName: "atomic.json",
        exportJson,
      })).rejects.toThrow("no messages were added");
    } finally {
      sqlite.exec("DROP TRIGGER reject_atomic_telegram_item;");
    }

    const sources = await app.db.select().from(app.schema.evidenceSources)
      .where(eq(app.schema.evidenceSources.userId, owner.id));
    const items = await app.db.select().from(app.schema.evidenceItems)
      .where(eq(app.schema.evidenceItems.userId, owner.id));
    expect(sources).toHaveLength(0);
    expect(items).toHaveLength(0);
  });

  it("rechecks Telegram case ownership inside the evidence transaction", async () => {
    const { importTelegramExport } = await import("../../server/telegramService");
    await expect(importTelegramExport(owner.id, "CASE_ALREADY_DELETED", {
      name: "Orphan attempt",
      type: "personal_chat",
      id: 101,
      messages: [{
        id: 1,
        type: "message",
        date: "2026-08-22T10:00:00",
        date_unixtime: "1787392800",
        text: "Must not be written",
      }],
    }, "orphan.json")).rejects.toThrow("no messages were added");

    const sources = await app.db.select().from(app.schema.evidenceSources)
      .where(eq(app.schema.evidenceSources.userId, owner.id));
    expect(sources).toHaveLength(0);
  });

  it("commits complete CSV and Telegram imports with canonical evidence linkage", async () => {
    const csvResult = await app.makeCaller(owner).bulkImport.uploadCSV({
      csvContent: "caseTitle,description,category,urgency\nImported case,Verified description,Civil,High",
      filename: "complete.csv",
    });
    expect(csvResult).toMatchObject({ success: true, totalRows: 1 });

    const telegramResult = await app.makeCaller(owner).telegramEnhanced.importExport({
      caseId,
      fileName: "complete.json",
      exportJson: JSON.stringify({
        name: "Complete chat",
        type: "personal_chat",
        id: 100,
        messages: [{
          id: 1,
          type: "message",
          date: "2026-08-22T10:00:00",
          date_unixtime: "1787392800",
          from: "Witness",
          text: "Verified message",
        }],
      }),
    });
    expect(telegramResult).toEqual({ success: true, messagesImported: 1, filesFound: 0 });

    const [job] = await app.db.select().from(app.schema.bulkImportJobs)
      .where(eq(app.schema.bulkImportJobs.id, csvResult.jobId));
    expect(job).toMatchObject({ status: "completed", processedRows: "1", failedRows: "0" });

    const [source] = await app.db.select().from(app.schema.evidenceSources)
      .where(eq(app.schema.evidenceSources.userId, owner.id));
    const [item] = await app.db.select().from(app.schema.evidenceItems)
      .where(eq(app.schema.evidenceItems.sourceId, source.id));
    expect(source).toMatchObject({
      caseId,
      provider: "telegram",
      sourceType: "telegram",
      connectionStatus: "imported",
      itemCount: 1,
    });
    expect(item).toMatchObject({
      caseId,
      userId: owner.id,
      sourceId: source.id,
      source: "telegram",
      content: "Verified message",
    });
  });
});
