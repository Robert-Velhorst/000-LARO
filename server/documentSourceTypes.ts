import type { stageInboxDocument } from "./documentInbox";
import { z } from "zod";

const accountId = z.string().min(1).max(200);
export const sourceConfigurationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), root: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("gmail"), accountId, query: z.string().max(2000).default(""), includeSpamTrash: z.boolean().default(false) }),
  z.object({ kind: z.literal("drive"), accountId, folderId: z.string().min(1).max(1000).optional() }),
]);
export type SourceConfiguration = z.infer<typeof sourceConfigurationSchema>;
export type SourceWork = { kind: string; key: string; label: string; isDocument: boolean; payload: Record<string, unknown>; continuation?: boolean; inboxId?: string };
export type SourceStepResult = { children?: SourceWork[]; document?: Parameters<typeof stageInboxDocument>[1] };
export const sourceCheckSchema = z.object({
  policyVersion: z.literal(1),
  checkedAt: z.string().datetime(),
  outcome: z.enum(["excluded", "needs_review"]),
  code: z.string(),
  basis: z.enum(["path_policy", "filesystem", "provider_metadata", "downloaded_bytes", "unverified"]),
  contentAssessed: z.literal(false),
  facts: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type SourceCheck = z.infer<typeof sourceCheckSchema>;
export class SourceSkip extends Error {
  readonly check: SourceCheck;
  constructor(message: string, check?: Pick<SourceCheck, "outcome" | "code" | "basis" | "facts">) {
    super(message);
    // A technical limitation never establishes that a document is irrelevant.
    this.check = sourceCheckSchema.parse({ policyVersion: 1, checkedAt: new Date().toISOString(), contentAssessed: false,
      outcome: "needs_review", code: "unverified_skip", basis: "unverified", facts: {}, ...check });
  }
}

export type SourceProvenance = {
  source: "local" | "gmail" | "google_drive";
  accountId?: string; objectId: string; version?: string; modifiedTime?: string;
  gmailMessageId?: string; gmailThreadId?: string; attachmentId?: string;
  gmailLabelIds?: string[];
  driveFileId?: string; driveAccountId?: string; sourceMimeType?: string;
};
