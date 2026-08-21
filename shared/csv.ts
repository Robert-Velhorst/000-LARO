function csvValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function neutralizeSpreadsheetFormula(value: string): string {
  return /^(?:[\t\r\n]|[\s\uFEFF]*[=+\-@])/u.test(value) ? `'${value}` : value;
}

export function encodeCsvCell(value: unknown): string {
  const text = csvValue(value);
  const rendered = typeof value === "string" ? neutralizeSpreadsheetFormula(text) : text;
  return /[",\r\n]/.test(rendered)
    ? `"${rendered.replace(/"/g, '""')}"`
    : rendered;
}

export function encodeCsvRows(rows: readonly (readonly unknown[])[], lineEnding = "\r\n"): string {
  return rows.map((row) => row.map(encodeCsvCell).join(",")).join(lineEnding);
}
