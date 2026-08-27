import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ASSETS = join(ROOT, "dist", "renderer", "assets");
function buildRenderer(): void {
  const command = process.platform === "win32"
    ? process.env.ComSpec || "cmd.exe"
    : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd run build:renderer"]
    : ["run", "build:renderer"];
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "pipe",
    windowsHide: true,
  });
}

function builtJavaScriptAssets(): Array<{ name: string; bytes: number }> {
  return readdirSync(ASSETS)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, bytes: statSync(join(ASSETS, name)).size }));
}

describe("case workspace bundle boundaries", () => {
  test("defers case-only workspaces until their matching action is selected", () => {
    buildRenderer();

    expect(existsSync(ASSETS)).toBe(true);
    const assets = builtJavaScriptAssets();
    const casesRoute = assets.find((asset) => /^Cases-[A-Za-z0-9_-]+\.js$/.test(asset.name));

    expect(casesRoute).toBeDefined();
    expect(casesRoute?.bytes).toBeLessThan(18 * 1024);
    expect(assets.some((asset) => /^EnhancedCaseDetailsDialog-[A-Za-z0-9_-]+\.js$/.test(asset.name))).toBe(true);
    expect(assets.some((asset) => /^CaseCreationWizard-[A-Za-z0-9_-]+\.js$/.test(asset.name))).toBe(true);
    expect(assets.some((asset) => /^BulkCaseImport-[A-Za-z0-9_-]+\.js$/.test(asset.name))).toBe(true);
    expect(assets.some((asset) => /^BulkEvidenceUpload-[A-Za-z0-9_-]+\.js$/.test(asset.name))).toBe(true);
  }, 30_000);
});
