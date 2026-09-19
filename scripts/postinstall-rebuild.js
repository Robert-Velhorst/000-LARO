/**
 * Refresh better-sqlite3 only when Electron and better-sqlite3 are installed.
 * Version 13 ships N-API binaries for every supported desktop platform, so an
 * Electron-ABI source rebuild is neither necessary nor portable.
 */
const { existsSync } = require("fs");
const { join } = require("path");
const { execFileSync } = require("child_process");

const root = join(__dirname, "..");
const electron = join(root, "node_modules", "electron");
const sqlite = join(root, "node_modules", "better-sqlite3");

if (existsSync(electron) && existsSync(sqlite)) {
  try {
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["rebuild", "better-sqlite3"], {
      cwd: root,
      stdio: "inherit",
    });
  } catch (e) {
    console.warn("[postinstall] native dependency refresh failed (optional for server-only dev):", e.message);
  }
}
