import { MAX_EVIDENCE_FILE_BYTES } from "../shared/evidenceFiles";
import { readBoundedResponseBytes, withBoundedHttpResponse } from "./boundedHttpResponse";
import { getManagedEvidenceDownloadUrl } from "./evidenceAccess";

export interface ManagedEvidenceSource {
  userId: string;
  evidenceId: string;
  storageKey: string;
}

function encodeQueryComponent(value: string): string {
  // SigV4 uses RFC 3986 encoding, including the characters left unescaped by
  // encodeURIComponent. Keep signed values intact while preventing delimiters
  // from becoming URL structure at the request boundary.
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function parseSourceUrl(value: string): URL {
  if (typeof value !== "string" || value.length > 16_384 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new Error("Invalid managed evidence source URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // URL parser errors can retain the original signed URL in an input field.
    throw new Error("Invalid managed evidence source URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("Invalid managed evidence source URL");
  }
  return url;
}

export async function fetchManagedEvidenceSource(url: string, source: ManagedEvidenceSource): Promise<Buffer> {
  // The authority is current owned storage metadata, not the supplied URL or
  // a caller-provided origin list. A changed owner/key or legacy URL is denied.
  const expected = parseSourceUrl(await getManagedEvidenceDownloadUrl(
    source.userId, source.evidenceId, source.storageKey,
  ));
  const requested = parseSourceUrl(url);
  if (requested.origin !== expected.origin || requested.pathname !== expected.pathname) {
    throw new Error("Evidence source does not match the selected managed object");
  }
  // Retain signed query values: reissuing a URL may rotate its timestamp or
  // signature. Build the network location only from the owned storage result,
  // with each untrusted query key/value encoded separately at the final sink.
  const query = [...requested.searchParams].map(([key, value]) =>
    `${encodeQueryComponent(key)}=${encodeQueryComponent(value)}`,
  ).join("&");
  const requestUrl = `${expected.origin}${expected.pathname}${query ? `?${query}` : ""}`;
  return withBoundedHttpResponse(
    () => fetch(requestUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) }),
    async (response) => {
      if (!response.ok) throw new Error(`Signed evidence URL returned HTTP ${response.status}`);
      return readBoundedResponseBytes(response, {
        maxBytes: MAX_EVIDENCE_FILE_BYTES,
        label: "Signed evidence response",
      });
    },
  );
}
