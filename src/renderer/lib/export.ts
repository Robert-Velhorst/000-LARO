import { encodeCsvRows } from "../../../shared/csv";

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  return encodeCsvRows([keys, ...rows.map((row) => keys.map((key) => row[key]))], "\n");
}

export function exportLawyersToCSV(lawyers: Record<string, unknown>[]) {
  downloadText(
    `lawyers-${Date.now()}.csv`,
    rowsToCsv(lawyers),
    "text/csv;charset=utf-8"
  );
}

export function exportLawyersToJSON(lawyers: unknown) {
  downloadText(
    `lawyers-${Date.now()}.json`,
    JSON.stringify(lawyers, null, 2),
    "application/json;charset=utf-8"
  );
}

export function exportCasesToCSV(cases: Record<string, unknown>[]) {
  downloadText(
    `cases-${Date.now()}.csv`,
    rowsToCsv(cases),
    "text/csv;charset=utf-8"
  );
}

export function exportCasesToJSON(cases: unknown) {
  downloadText(
    `cases-${Date.now()}.json`,
    JSON.stringify(cases, null, 2),
    "application/json;charset=utf-8"
  );
}

function caseSummaryText(data: unknown): string {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, v]) =>
        `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`
      )
      .join("\n");
  }
  return String(data);
}

export function exportCaseSummary(caseData: unknown) {
  const id =
    caseData &&
    typeof caseData === "object" &&
    "id" in caseData &&
    typeof (caseData as { id: unknown }).id === "string"
      ? (caseData as { id: string }).id.slice(0, 12)
      : "case";
  downloadText(
    `case-summary-${id}-${Date.now()}.txt`,
    caseSummaryText(caseData),
    "text/plain;charset=utf-8"
  );
}

export function printCaseSummary(caseData: unknown) {
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.open();
  w.document.write(
    `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Case summary</title>` +
      `<style>body{font-family:system-ui,sans-serif;padding:1rem;white-space:pre-wrap;}</style></head><body></body></html>`
  );
  w.document.close();
  w.document.body.textContent = caseSummaryText(caseData);
  w.focus();
  w.print();
}
