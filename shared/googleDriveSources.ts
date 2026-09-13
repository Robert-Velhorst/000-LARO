import { z } from "zod";

export const googleDriveSourcesSchema = z.array(z.object({
  accountId: z.string().min(1).max(256),
  folderIds: z.array(z.string().min(1).max(1024)).min(1).max(200),
  folderNames: z.array(z.string().max(1024)).max(200).optional(),
})).max(50).refine(
  (sources) => new Set(sources.map((source) => source.accountId)).size === sources.length,
  "Select each Google account only once",
);

export type GoogleDriveSource = z.infer<typeof googleDriveSourcesSchema>[number];

// An explicitly empty selection means no Drive access, never a fallback to root.
export function savedGoogleDriveSources(metadata: string | null | undefined): GoogleDriveSource[] | undefined {
  if (!metadata) return undefined;
  const parsed = JSON.parse(metadata);
  if (parsed.googleDriveSources === undefined) return undefined;
  return googleDriveSourcesSchema.parse(parsed.googleDriveSources);
}
