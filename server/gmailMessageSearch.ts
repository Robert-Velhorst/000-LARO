import { z } from "zod";
import { readBoundedResponseJson, withBoundedHttpResponse } from "./boundedHttpResponse";

const pageSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).default([]),
  nextPageToken: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});
const MAX_MESSAGES = 1000;
const MAX_PAGES = 100;

export async function searchGmailMessageIds(
  accessToken: string,
  query: string,
  maxMessages = MAX_MESSAGES,
  signal?: AbortSignal,
): Promise<{
  messages: Array<{ id: string }>;
  warnings: string[];
}> {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  const warnings: string[] = [];
  let pageToken: string | undefined;
  const messageLimit = Math.max(1, Math.min(MAX_MESSAGES, Math.floor(maxMessages)));
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ maxResults: String(Math.min(100, messageLimit - ids.size)), q: query });
    if (pageToken) params.set("pageToken", pageToken);
    try {
      const data = await withBoundedHttpResponse(
        () => fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?${params}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        }),
        async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const parsed = pageSchema.safeParse(await readBoundedResponseJson(response, {
            maxBytes: 1024 * 1024, label: "Gmail search response",
          }));
          if (!parsed.success) throw new Error("invalid Gmail search response");
          if (parsed.data.error) throw new Error("Gmail returned an error response");
          return parsed.data;
        },
      );
      for (const message of data.messages) {
        if (ids.size >= messageLimit) break;
        ids.add(message.id);
      }
      pageToken = data.nextPageToken || undefined;
      if (!pageToken) break;
      if (ids.size >= messageLimit) {
        warnings.push(`Partial Gmail search: ${messageLimit} message limit reached; narrow the date range or keywords to collect the remainder.`);
        break;
      }
      if (cursors.has(pageToken)) {
        warnings.push("Partial Gmail search: provider repeated a page token.");
        break;
      }
      cursors.add(pageToken);
      if (page === MAX_PAGES - 1) warnings.push("Partial Gmail search: page limit reached; narrow the date range or keywords.");
    } catch (error) {
      warnings.push(`Partial Gmail search: ${error instanceof Error ? error.message : "request failed"}.`);
      break;
    }
  }
  return { messages: [...ids].map((id) => ({ id })), warnings };
}
