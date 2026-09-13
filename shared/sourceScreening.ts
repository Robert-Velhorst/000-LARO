import { z } from "zod";

export const sourceScreenSchema = z.object({
  version: z.literal(1), checkedAt: z.string(), sourceVersion: z.string().nullable(),
  tier: z.enum(["priority", "normal", "low", "unavailable"]),
  fileBytes: z.number().nonnegative(), sampledBytes: z.number().nonnegative(), elapsedMs: z.number().nonnegative(),
  reasons: z.array(z.string()),
});
export type SourceScreen = z.infer<typeof sourceScreenSchema>;
export const SAMPLE_BLOCK_BYTES = 8192;
export const SCREEN_TEXT_EXTENSIONS = new Set([".txt", ".csv", ".html", ".htm", ".eml", ".md", ".json", ".log", ".ini", ".yaml", ".yml", ".js", ".ts", ".py", ".css"]);

export function classifySourceSample(filePath: string, samples: string[]): Pick<SourceScreen, "tier" | "reasons"> {
  // Absence from a partial sample is not evidence of irrelevance.
  const legal = /\b(zaaknummer|dossiernummer|bezwaarschrift|dagvaarding|ingebrekestelling|huurovereenkomst|aansprakelijk|rechtbank|uitspraak|bezwaar|beroep|besluit|contract|eviction|court|summons|claim number|case number|lease agreement)\b/i;
  if (samples.some(text => legal.test(text))) return { tier: "priority", reasons: ["Legal/document signal in a sampled text fragment"] };
  const parts = filePath.toLowerCase().split(/[\\/]/);
  const name = parts.at(-1) || "";
  const technicalTree = parts.slice(0, -1).some(part => ["src", "dist", "build", "assets", "icons", "tests", "fixtures", "site-packages"].includes(part));
  const assetName = /^(icon|logo|tray[-_]|favicon|apple-touch-icon|square\d|\d+x\d+)/.test(name) && /\.(png|ico|svg|webp|jpg)$/.test(name);
  const sourceCode = /\.(js|ts|py|css|ini)$/.test(name) && samples.some(text => /(^|\n)\s*(import |from \w|export |def |class |\[pytest\]|[.#][\w-]+\s*\{)/.test(text));
  if (technicalTree && (assetName || sourceCode)) return { tier: "low", reasons: ["Software directory context", assetName ? "Conventional application asset name" : "Source-code syntax in sampled text", samples.length ? "No legal signal in sampled text; relevance remains unconfirmed" : "Image content has not been read or OCRed; relevance remains unconfirmed"] };
  return { tier: "normal", reasons: [samples.length ? "No decisive signal in partial text; retain for analysis" : "Content requires extraction or OCR; retain for analysis"] };
}
