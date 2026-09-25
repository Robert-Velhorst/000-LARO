// Parser/provider exceptions can contain document text or credentials. Only expose known categories.
const causes = {
  file_access: ["Access to the file was denied or the file was locked.", "Check file permissions and close applications locking it, then retry."],
  file_missing: ["The source file or folder could not be found.", "Reconnect the drive or restore the source location, then retry."],
  storage_full: ["There is not enough storage space.", "Free space on the storage drive, then retry."],
  file_changed: ["The source changed while LARO was reading it.", "Wait until the source stops changing, then retry or run a new inventory."],
  inventory_incomplete: ["The source inventory is incomplete; the provider did not return a reliable complete listing.", "Select a narrower source folder or start a new inventory."],
  provider_error: ["The external service returned a server error.", "Wait for the service to recover, then retry."],
  timeout: ["Processing exceeded its time limit.", "Check the analysis service and try a smaller document or retry."],
  connection: ["The processing service could not be reached.", "Check the connection and, for local analysis, that the local model service is running."],
  google_access: ["Google rejected access or the account connection is no longer available.", "Reconnect the Google account in Settings and check its permissions."],
  rate_limit: ["The service is busy or its request limit was reached.", "Wait before retrying. Check provider usage limits when applicable."],
  protected_document: ["The document reader reported password protection or encryption.", "Provide an unlocked copy that you are authorized to read, then retry."],
  unreadable: ["The document reader could not parse this file.", "Open the original to check it, or export a fresh PDF/text copy and import it."],
  resource_limit: ["The document exceeded a text, page, image or archive processing limit.", "Split or reduce the document and import the smaller parts; keep the original."],
  model_unconfigured: ["The selected analysis provider is not configured.", "Select and configure an analysis provider in Settings, then retry analysis."],
  unsupported_findings: ["Analysis findings were rejected because their cited passages did not support them.", "Review the source and retry analysis; unsupported findings were not accepted."],
  incomplete_analysis: ["Document analysis did not finish successfully.", "Check the analysis provider and retry. Already saved originals remain available."],
  unknown: ["No specific failure cause was recorded.", "Check the original and analysis settings, then retry. A new failure will be checked again."],
} as const;
export function describeSourceFailure(error: unknown) {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const errorCode = error instanceof Error && "code" in error ? String(error.code) : "";
  const text = `${errorCode} ${error instanceof Error ? error.name : ""} ${message}`;
  let code: keyof typeof causes = "unknown";
  const recorded = /^\[([a-z_]+)\]/.exec(message)?.[1];
  if (recorded && Object.prototype.hasOwnProperty.call(causes, recorded)) code = recorded as keyof typeof causes;
  else if (/EACCES|EPERM|EBUSY/.test(text)) code = "file_access";
  else if (/ENOENT|ENOTDIR/.test(text)) code = "file_missing";
  else if (/ENOSPC|SQLITE_FULL/.test(text)) code = "storage_full";
  else if (/changed (during|before|while)|changed or is no longer available/i.test(text)) code = "file_changed";
  else if (/search is incomplete|repeated a continuation cursor|inventory is incomplete/i.test(text)) code = "inventory_incomplete";
  else if (/timed? ?out|timeout|exceeded the .* (minute|second).*limit/i.test(text)) code = "timeout";
  else if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed/i.test(text)) code = "connection";
  else if (/HTTP 429|queue is full|processing is busy/i.test(text)) code = "rate_limit";
  else if (/Google.*(HTTP (401|403)|unavailable|reconnection|reconnect)|invalid_grant|selected provider account.*(not found|unsupported)|reconnect the selected provider account|multiple provider accounts.*select one account/i.test(text)) code = "google_access";
  else if (/HTTP 5\d\d/.test(text)) code = "provider_error";
  else if (/password.?protected|encrypted (pdf|document)|PasswordException|no password given|incorrect password/i.test(text)) code = "protected_document";
  else if (/invalid pdf|invalid.*(image|archive|zip)|end of central directory|unsupported image|corrupt/i.test(text)) code = "unreadable";
  else if (/exceeds.*(limit|size)|requires OCR for more than/i.test(text)) code = "resource_limit";
  else if (/not configured|provider unavailable/i.test(text)) code = "model_unconfigured";
  else if (/UNSUPPORTED_PROVIDER_FINDINGS|findings lacked literal support/i.test(text)) code = "unsupported_findings";
  else if (/analysis.*(incomplete|failed)|chunk\(s\) were rejected or failed/i.test(text)) code = "incomplete_analysis";
  return { code, cause: causes[code][0], nextStep: causes[code][1] };
}
export function sourceFailureMessage(error: unknown): string {
  const failure = describeSourceFailure(error);
  return `[${failure.code}] ${failure.cause} Next step: ${failure.nextStep}`;
}
