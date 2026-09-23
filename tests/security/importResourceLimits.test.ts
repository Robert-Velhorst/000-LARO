import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { IMPORT_LIMITS, normalizeCaseCsvImport } from "../../server/importLimits";

const suite = sqliteAvailable ? describe : describe.skip;

suite("bounded and atomic bulk imports", () => {
  let app: TestApp;
  const owner = { id: "IMPORT_OWNER", email: "imports@example.test", role: "user" };
  const caseId = "CASE_IMPORT_BASELINE";

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

  it("rejects structurally amplified CSV input", () => {
    const csv = `caseTitle,description\n${Array.from(
      { length: IMPORT_LIMITS.csv.maxColumns + 1 },
      (_, index) => `value${index}`,
    ).join(",")}`;
    expect(() => normalizeCaseCsvImport(csv, "wide.csv")).toThrow("columns");
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
    expect(importedCases.map((row: { id: string }) => row.id)).toEqual([caseId]);
    expect(jobs).toHaveLength(0);
  });

  it("commits a complete CSV import", async () => {
    const result = await app.makeCaller(owner).bulkImport.uploadCSV({
      csvContent: "caseTitle,description,category,urgency\nImported case,Verified description,Civil,High",
      filename: "complete.csv",
    });
    expect(result).toMatchObject({ success: true, totalRows: 1 });

    const [job] = await app.db.select().from(app.schema.bulkImportJobs)
      .where(eq(app.schema.bulkImportJobs.id, result.jobId));
    expect(job).toMatchObject({ status: "completed", processedRows: "1", failedRows: "0" });
  });
});
