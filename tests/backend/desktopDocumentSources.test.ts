import { describe, expect, it, vi } from "vitest";
import { pickAndStartLocalSource } from "../../src-main/documentSources";

describe("native case-neutral source admission", () => {
  it("does not transmit a desktop folder to a separately hosted loopback API", async () => {
    const pickFolder = vi.fn(); const start = vi.fn();
    await expect(pickAndStartLocalSource({ apiUrl: "http://127.0.0.1:3187", remote: true, pickFolder, start })).rejects.toThrow(/Document inbox/);
    expect(pickFolder).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it("rejects remote APIs before selecting or transmitting a local path", async () => {
    const pickFolder = vi.fn(); const start = vi.fn();
    await expect(pickAndStartLocalSource({ apiUrl: "https://laro.example.test", pickFolder, start })).rejects.toThrow(/local/i);
    expect(pickFolder).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it("does not start work when the native folder picker is cancelled", async () => {
    const start = vi.fn();
    expect(await pickAndStartLocalSource({ apiUrl: "http://127.0.0.1:3000", pickFolder: async () => null, start })).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
  it("uses only the native selected folder and never requires a case", async () => {
    const start = vi.fn(async () => ({ id: "source-job" }));
    expect(await pickAndStartLocalSource({ apiUrl: "http://127.0.0.1:3000", pickFolder: async () => "C:\\Selected", start })).toEqual({ id: "source-job" });
    expect(start).toHaveBeenCalledWith({ kind: "local", root: "C:\\Selected" });
  });
});
