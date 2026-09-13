import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";
import { classifySourceSample } from "../../shared/sourceScreening";

describe("conservative fast screening rules", () => {
  it("never treats missing keywords or opaque formats as irrelevant", () => {
    expect(classifySourceSample("photos/evidence.png", []).tier).toBe("normal");
    expect(classifySourceSample("case/scan.pdf", []).tier).toBe("normal");
    expect(classifySourceSample("notes.txt", ["We met on Monday."]).tier).toBe("normal");
    expect(classifySourceSample("personal/logo.png", []).tier).toBe("normal");
  });
  it("requires multiple software signals, with legal text taking precedence", () => {
    expect(classifySourceSample("project/assets/icon.png", []).tier).toBe("low");
    expect(classifySourceSample("project/src/main.py", ["import os\n"]).tier).toBe("low");
    expect(classifySourceSample("project/src/main.py", ["import os\n# Zaaknummer 456"]).tier).toBe("priority");
  });
});

(sqliteAvailable ? describe : describe.skip)("durable fast screening", () => {
  let app: TestApp;
  const owner = { id: "SKIM_OWNER", email: "skim@example.test", role: "user" };
  beforeAll(async () => { app = await bootTestApp(); await app.db.insert(app.schema.users).values(buildUser(owner)); });
  afterAll(() => app?.cleanup());
  it("samples bounded fragments from files above the import size limit, including the tail", async () => {
    const file = join(app.tmpDir, "large.txt");
    const bytes = Buffer.alloc(9 * 1024 * 1024, "x");
    bytes.write("\nZaaknummer 6789\n", bytes.length - 60);
    writeFileSync(file, bytes);
    const { screenLocalSourceFile, grantLocalSourceRoot } = await import("../../server/localDocumentSource");
    const result = await screenLocalSourceFile(await grantLocalSourceRoot(app.tmpDir), file);
    expect(result.tier).toBe("priority");
    expect(result.sampledBytes).toBeLessThanOrEqual(24576);
    expect(result.fileBytes).toBe(bytes.length);
  });
  it("does not read protected locations and does not loop on unavailable screening", async () => {
    const { screenLocalSourceBatch, grantLocalSourceRoot } = await import("../../server/localDocumentSource");
    const result = await screenLocalSourceBatch(await grantLocalSourceRoot(app.tmpDir), [join(app.tmpDir, ".ssh", "private.txt"), join(app.tmpDir, "missing.txt")]);
    expect(result.every(item => item.tier === "unavailable" && item.sampledBytes === 0)).toBe(true);
  });
  it("invalidates cached screening when source bytes change", async () => {
    const folder = join(app.tmpDir, "src"); mkdirSync(folder);
    const file = join(folder, "example.py"); writeFileSync(file, "import os\n");
    const { screenLocalSourceFile, executeLocalSourceWork, grantLocalSourceRoot } = await import("../../server/localDocumentSource");
    const root = await grantLocalSourceRoot(app.tmpDir);
    const screening = await screenLocalSourceFile(root, file);
    expect(screening.tier).toBe("low");
    writeFileSync(file, "# Zaaknummer: CHANGED-2026-123\nDocument evidence changed\n");
    // The .py format still needs review, but the obsolete software deferral must not survive.
    await expect(executeLocalSourceWork({ kind: "local", root }, "local_file", { path: file, screening }))
      .rejects.toMatchObject({ check: { code: "unsupported_format", outcome: "needs_review" } });
  });
  it("defers likely assets with an audit, prioritizes content signals, and allows explicit inclusion", async () => {
    const root = join(app.tmpDir, "collection"); mkdirSync(root); mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "icon.png"), "opaque test fixture, not a real image");
    writeFileSync(join(root, "notes.txt"), "Ordinary notes with uncertain relevance.");
    writeFileSync(join(root, "decision.txt"), "Zaaknummer: QUICK-2026-002\nBesluit gemeente.");
    const caller = app.makeCaller(owner, "session", true);
    const { runSourceQueueStep } = await import("../../server/documentSourceQueue");
    const job = await caller.documentSources.start({ kind: "local", root });
    for (let index = 0; index < 4; index++) await runSourceQueueStep(job.id, "import");
    const skimmed = await caller.documentSources.get({ id: job.id });
    expect(skimmed.counts.imported).toBe(0);
    expect(skimmed.screening.reduce((sum: number, row: any) => sum + row.count, 0)).toBe(3);
    expect(skimmed.screening.find((row: any) => row.tier === "priority").count).toBe(1);
    const asset = skimmed.items.find((item: any) => item.label.endsWith("icon.png"));
    expect(asset.status).toBe("deferred");
    expect(asset.screening.tier).toBe("low");
    const events = await app.db.select().from(app.schema.auditLogs).where(eq(app.schema.auditLogs.entityId, asset.id));
    expect(events.some((event: any) => event.action === "source.item_screened")).toBe(true);
    await runSourceQueueStep(job.id, "import");
    expect((await caller.documentInbox.list({ view: "all" })).items[0].fileName).toBe("decision.txt");
    await caller.documentSources.recheck({ id: job.id, workId: asset.id });
    await runSourceQueueStep(job.id, "import", asset.id);
    expect((await caller.documentSources.get({ id: job.id })).items.find((item: any) => item.id === asset.id).status).toBe("done");
    await caller.documentSources.pause({ id: job.id });
  });
});
