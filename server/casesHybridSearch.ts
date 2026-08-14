import { and, eq, like, or } from "drizzle-orm";
import { getDb } from "./db";
import { cases } from "./schema";
import { invokeLLM, isLLMProviderConfigured, isLocalLLMProvider } from "./llm";
import { globalSearch } from "./globalSearch";
import { getWorkflowPreferences } from "./workflowPreferences";

const STOP = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "my", "is", "are", "was", "were",
  "i", "me", "with", "that", "this", "how", "what", "when", "where", "help", "case", "legal", "need",
]);

function tokenizeHeuristic(q: string): string[] {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const words = trimmed
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w.replace(/[^a-z]/g, "")));
  return [...new Set([trimmed, ...words])].slice(0, 14);
}

async function expandCaseSearchTerms(query: string, userId: string): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const preferences = await getWorkflowPreferences(userId);
  const provider = preferences.analysisProvider === "local" ? null : preferences.analysisProvider;
  const hasLlm = Boolean(provider && (isLocalLLMProvider(provider) || preferences.shareRawDocumentContent) && isLLMProviderConfigured(provider));

  if (!hasLlm) {
    return tokenizeHeuristic(trimmed);
  }

  try {
    const res = await invokeLLM({
      provider: provider!,
      messages: [
        {
          role: "system",
          content:
            'Extract search tokens for a legal case database (client name, matter type, keywords). Reply with JSON only: {"terms":["..."]} — 3 to 10 short strings, no commentary.',
        },
        { role: "user", content: trimmed.slice(0, 4000) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 300,
    });
    const raw = res.choices?.[0]?.message?.content;
    let text = "";
    if (typeof raw === "string") text = raw;
    else if (Array.isArray(raw)) {
      text = raw
        .map((p) => (typeof p === "object" && p && "type" in p && p.type === "text" ? String((p as { text?: string }).text ?? "") : ""))
        .join("");
    }
    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { terms?: string[] };
    if (Array.isArray(parsed?.terms) && parsed.terms.length) {
      return [...new Set([trimmed, ...parsed.terms.map((t) => String(t).trim()).filter(Boolean)])].slice(0, 16);
    }
  } catch {
    /* heuristic fallback */
  }
  return tokenizeHeuristic(trimmed);
}

/** Keyword + optional NL-expanded OR search; merges with globalSearch case hits. */
export async function hybridCaseSearch(query: string, userId: string): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const terms = await expandCaseSearchTerms(trimmed, userId);
  const ids = new Set<string>();

  const db = await getDb();
  if (db) {
    for (const t of terms) {
      const safe = t.replace(/[%_]/g, "").trim();
      if (safe.length < 2) continue;
      const p = `%${safe}%`;
      try {
        const rows = await db
          .select({ id: cases.id })
          .from(cases)
          .where(
            and(
              eq(cases.userId, userId),
              or(like(cases.clientName, p), like(cases.caseType, p), like(cases.caseSummary, p))
            )
          )
          .limit(40);
        rows.forEach((r) => ids.add(r.id));
      } catch {
        /* ignore term */
      }
    }
  }

  try {
    const gs = await globalSearch(trimmed, { types: ["case"], limit: 40, userId });
    gs.forEach((r) => {
      if (r.type === "case") ids.add(r.id);
    });
  } catch {
    /* ignore */
  }

  return [...ids];
}
