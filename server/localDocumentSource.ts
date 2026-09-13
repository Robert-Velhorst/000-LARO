import * as fs from "fs/promises";
import path from "path";
import mime from "mime-types";
import { z } from "zod";
import { classifySourceSample, SAMPLE_BLOCK_BYTES, SCREEN_TEXT_EXTENSIONS, sourceScreenSchema, type SourceScreen } from "../shared/sourceScreening";
import { MAX_EVIDENCE_FILE_BYTES, isSupportedDocumentAnalysisMimeType } from "../shared/evidenceFiles";
import { SourceSkip, type SourceConfiguration, type SourceStepResult, type SourceWork } from "./documentSourceTypes";

const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const EXCLUDED_DIRECTORIES = new Set(["appdata", "application data", "local settings", "windows", "program files", "program files (x86)",
  "programdata", "system volume information", "$recycle.bin", "recovery", "node_modules", "__pycache__", "venv", "vendor", "codex"]);
export function localSourceExclusion(relativePath: string): string | null {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (parts.some(part => part.startsWith(".") || EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) {
    return "System, hidden, credential, cache and development directories are excluded from source intake";
  }
  const name = parts.at(-1) || "";
  if (/^(passwords?|credentials?|secrets?|tokens?)([._ -]|$)/i.test(name)) return "Credential files are excluded from source intake";
  return null;
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
export async function grantLocalSourceRoot(root: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(root));
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error("Select a local directory");
  return resolved;
}
async function checkedPath(root: string, target: string) {
  const full = path.resolve(target);
  const excluded = localSourceExclusion(path.relative(root, full));
  if (excluded) throw new SourceSkip(excluded, { outcome: "excluded", code: "protected_path", basis: "path_policy",
    facts: { relativePath: path.relative(root, full), rule: excluded } });
  if (!inside(root, full) || !samePath(await fs.realpath(root), root) || !samePath(await fs.realpath(full), full)) {
    throw new SourceSkip("Source path leaves the granted folder or traverses a symbolic link/junction", {
      outcome: "excluded", code: "source_boundary", basis: "filesystem", facts: { path: full, grantedRoot: root } });
  }
  const info = await fs.lstat(full);
  if (info.isSymbolicLink()) throw new SourceSkip("Symbolic links and junctions are not followed", {
    outcome: "excluded", code: "symbolic_link", basis: "filesystem", facts: { path: full, isSymbolicLink: true } });
  return { full, info };
}
const version = (info: Awaited<ReturnType<typeof fs.stat>>) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
const payloadSchema = z.object({ path: z.string().min(1), after: z.string().optional(), directoryVersion: z.string().optional(),
  screening: sourceScreenSchema.optional(), allowLowPriority: z.boolean().optional() });

export class SourceScreenDeferred extends Error {
  constructor(readonly screen: SourceScreen) { super("Fast skim: likely software material. Deferred for review, not declared irrelevant. Choose Analyze anyway to include it."); }
}

export async function screenLocalSourceFile(root: string, target: string): Promise<SourceScreen> {
  const started = performance.now();
  const { full, info } = await checkedPath(root, target);
  if (!info.isFile()) throw new Error("Only regular files can be skimmed");
  const samples: string[] = [];
  let sampledBytes = 0;
  if (SCREEN_TEXT_EXTENSIONS.has(path.extname(full).toLowerCase()) && info.size) {
    const handle = await fs.open(full, "r");
    try {
      if (version(await handle.stat()) !== version(info)) throw new Error("Source changed before skimming");
      const positions = [...new Set([0, Math.max(0, Math.floor(info.size / 2) - SAMPLE_BLOCK_BYTES / 2), Math.max(0, info.size - SAMPLE_BLOCK_BYTES)])];
      for (const position of positions) {
        const buffer = Buffer.alloc(Math.min(SAMPLE_BLOCK_BYTES, info.size - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        sampledBytes += bytesRead;
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        // Binary/unknown encodings do not earn a low-priority content classification.
        if (!text.includes("\0") && !text.includes("\uFFFD")) samples.push(text);
      }
      if (version(await handle.stat()) !== version(info)) throw new Error("Source changed during skimming");
    } finally { await handle.close(); }
  }
  if (version((await checkedPath(root, full)).info) !== version(info)) throw new Error("Source changed during skimming");
  return { version: 1, checkedAt: new Date().toISOString(), sourceVersion: version(info), fileBytes: info.size, sampledBytes,
    elapsedMs: performance.now() - started, ...classifySourceSample(full, samples) };
}

export async function screenLocalSourceBatch(root: string, paths: string[]): Promise<SourceScreen[]> {
  if (paths.length > 256) throw new Error("Skim batch exceeds 256 items");
  const results: SourceScreen[] = new Array(paths.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= paths.length) return;
      try { results[index] = await screenLocalSourceFile(root, paths[index]); }
      catch { results[index] = { version: 1, checkedAt: new Date().toISOString(), sourceVersion: null, tier: "unavailable",
        fileBytes: 0, sampledBytes: 0, elapsedMs: 0, reasons: ["Skim unavailable; normal access/format checks are still required"] }; }
    }
  }));
  return results;
}

export async function executeLocalSourceWork(config: Extract<SourceConfiguration, { kind: "local" }>, kind: string, raw: unknown): Promise<SourceStepResult> {
  const payload = payloadSchema.parse(raw);
  const { full, info } = await checkedPath(config.root, payload.path);
  if (kind === "local_page") {
    if (!info.isDirectory()) throw new Error("Source folder is no longer a directory");
    const directoryVersion = version(info);
    if (payload.directoryVersion && payload.directoryVersion !== directoryVersion) throw new Error("Folder changed during inventory; start a new inventory to include changes");
    // Keyset pages are stable across restart; retain only the next 100 names.
    // Do not depend on OS directory enumeration order or keep an entire tree in memory.
    const names: string[] = [];
    let visited = 0;
    const directory = await fs.opendir(full);
    for await (const entry of directory) {
      if (++visited > 250_000) throw new Error("Directory exceeds the per-page enumeration limit; select smaller source folders");
      if (payload.after && entry.name <= payload.after) continue;
      names.push(entry.name); names.sort();
      if (names.length > 101) names.pop();
    }
    if (version((await checkedPath(config.root, full)).info) !== directoryVersion) throw new Error("Folder changed during inventory; start a new inventory to include changes");
    const children: SourceWork[] = [];
    for (const name of names.slice(0, 100)) {
      const childPath = path.join(full, name);
      // Keep an outcome for inaccessible/excluded entries without aborting the page.
      let isDirectory = false;
      if (!localSourceExclusion(path.relative(config.root, childPath))) {
        try { const child = await fs.lstat(childPath); isDirectory = child.isDirectory() && !child.isSymbolicLink(); }
        catch { /* The individual work item records the failure. */ }
      }
      children.push({ kind: isDirectory ? "local_page" : "local_file", key: childPath, label: childPath,
        isDocument: !isDirectory, payload: { path: childPath } });
    }
    if (names.length > 100) {
      const after = names[99];
      children.push({ kind: "local_page", key: `${full}\0${after}`, label: full, isDocument: false,
        payload: { path: full, after, directoryVersion }, continuation: true });
    }
    return { children };
  }
  if (kind !== "local_file") throw new Error("Unknown local source work type");
  if (!info.isFile()) throw new SourceSkip("Only regular files are imported", {
    outcome: "excluded", code: "not_regular_file", basis: "filesystem", facts: { isFile: false, isDirectory: info.isDirectory() } });
  const screening = payload.screening?.sourceVersion === version(info) ? payload.screening : await screenLocalSourceFile(config.root, full);
  if (screening.tier === "low" && !payload.allowLowPriority) throw new SourceScreenDeferred(screening);
  const mimeType = mime.lookup(full) || "application/octet-stream";
  const facts = { extension: path.extname(full), declaredMimeType: mimeType, sizeBytes: info.size, version: version(info) };
  if (!isSupportedDocumentAnalysisMimeType(mimeType)) throw new SourceSkip("The filename indicates an unsupported format. Contents and legal relevance have not been assessed; review or convert the original.", {
    outcome: "needs_review", code: "unsupported_format", basis: "filesystem", facts });
  if (!info.size || info.size > MAX_EVIDENCE_FILE_BYTES) throw new SourceSkip("The measured file size is empty or above the import limit. Legal relevance is unknown; review the original.", {
    outcome: "needs_review", code: info.size ? "size_limit" : "empty_file", basis: "filesystem", facts: { ...facts, limitBytes: MAX_EVIDENCE_FILE_BYTES } });
  const handle = await fs.open(full, "r");
  try {
    const opened = await handle.stat();
    if (version(info) !== version(opened)) throw new Error("Source changed before reading; retry the document");
    const buffer = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const finalPath = await checkedPath(config.root, full);
    if (used !== info.size || version(await handle.stat()) !== version(info) || version(finalPath.info) !== version(info)) {
      throw new Error("Source changed while reading; no mixed version was imported");
    }
    return { document: { fileName: path.basename(full), sourcePath: full, mimeType, bytes: buffer.subarray(0, used),
      provenance: { source: "local", objectId: full, version: version(info), modifiedTime: info.mtime.toISOString() } } };
  } finally { await handle.close(); }
}
