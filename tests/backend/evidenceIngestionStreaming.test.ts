import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storagePutStream } from "../../server/storage";

describe("streamed evidence storage", () => {
  let directory: string;
  let previousStorage: string | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "laro-ingestion-stream-"));
    previousStorage = process.env.LOCAL_STORAGE_DIR;
    process.env.LOCAL_STORAGE_DIR = directory;
    delete process.env.AWS_S3_BUCKET;
  });

  afterAll(async () => {
    if (previousStorage === undefined) delete process.env.LOCAL_STORAGE_DIR;
    else process.env.LOCAL_STORAGE_DIR = previousStorage;
    await rm(directory, { recursive: true, force: true });
  });

  it("writes incremental chunks and returns the measured receipt", async () => {
    async function* chunks() {
      yield Buffer.from("bounded-");
      yield Buffer.from("stream");
    }
    const stored = await storagePutStream("evidence/case/stream.txt", chunks(), "text/plain", {
      maxBytes: 14,
      expectedBytes: 14,
    });
    expect(stored).toMatchObject({ bytes: 14 });
    expect(await readFile(join(directory, stored.key), "utf8")).toBe("bounded-stream");
  });

  it("stops an over-limit stream and leaves no managed object or temp file", async () => {
    async function* chunks() {
      yield Buffer.alloc(4, 0x61);
      yield Buffer.alloc(4, 0x62);
    }
    await expect(storagePutStream("evidence/case/too-large.bin", chunks(), "application/octet-stream", {
      maxBytes: 7,
    })).rejects.toThrow("write limit");
    await expect(readFile(join(directory, "evidence/case/too-large.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    const files = await import("node:fs/promises").then((fs) => fs.readdir(join(directory, "evidence/case")));
    expect(files.some((file) => file.includes(".upload-"))).toBe(false);
  });
});
