import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("bounded storage reads", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a local object from metadata before buffering beyond the caller limit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "laro-storage-limit-"));
    directories.push(directory);
    vi.stubEnv("LOCAL_STORAGE_DIR", directory);
    vi.stubEnv("AWS_S3_BUCKET", "");
    vi.resetModules();
    const { storagePut, storageRead } = await import("../../server/storage");
    const stored = await storagePut("limits/large.bin", Buffer.alloc(2_048, 1));

    await expect(storageRead(stored.key, { maxBytes: 1_024 }))
      .rejects.toThrow("Storage object exceeds the 1024 byte read limit");
  });
});
