export async function pickAndStartLocalSource(options: {
  apiUrl: string;
  remote?: boolean;
  pickFolder: () => Promise<string | null>;
  start: (input: { kind: "local"; root: string }) => Promise<{ id: string }>;
}): Promise<{ id: string } | null> {
  if (options.remote) throw new Error("Use Folder in the Document inbox to upload to the shared server. Background local sources require the local desktop workspace.");
  const url = new URL(options.apiUrl);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password) throw new Error("Local source intake requires the local LARO API");
  const root = await options.pickFolder();
  return root ? options.start({ kind: "local", root }) : null;
}
