function tableColumns(sqlite: any, table: string): string[] {
  const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return columns.map((column) => column.name);
}

function storageKeysFromRow(row: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  for (const field of ["storageKey", "s3Key"] as const) {
    const value = row[field];
    if (typeof value === "string" && value.trim()) keys.add(value.trim());
  }

  if (typeof row.metadata === "string" && row.metadata) {
    try {
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      for (const field of ["storageKey", "s3Key"] as const) {
        const value = metadata[field];
        if (typeof value === "string" && value.trim()) keys.add(value.trim());
      }
    } catch {
      // Legacy metadata can be free text and therefore has no managed key.
    }
  }
  return [...keys];
}

export function managedStorageKeyFromMetadata(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  return storageKeysFromRow({ metadata })[0] ?? null;
}

export function collectManagedStorageKeys(
  sqlite: any,
  scope: { userId?: string; caseIds?: string[] }
): string[] {
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((table) => table.name)
    .filter((name) =>
      !name.startsWith("sqlite_")
      && !name.startsWith("__")
      && name !== "storage_deletion_queue"
    );
  const keys = new Set<string>();

  for (const table of tables) {
    const columns = tableColumns(sqlite, table);
    const storageColumns = ["storageKey", "s3Key", "metadata"].filter((column) => columns.includes(column));
    if (storageColumns.length === 0) continue;

    let rows: Array<Record<string, unknown>> = [];
    const select = storageColumns.map((column) => `"${column}"`).join(", ");
    if (scope.userId && columns.includes("userId")) {
      rows = sqlite.prepare(`SELECT ${select} FROM "${table}" WHERE userId = ?`).all(scope.userId);
    } else if (scope.caseIds?.length && columns.includes("caseId")) {
      const placeholders = scope.caseIds.map(() => "?").join(",");
      rows = sqlite.prepare(`SELECT ${select} FROM "${table}" WHERE caseId IN (${placeholders})`).all(...scope.caseIds);
    } else if (!scope.userId && !scope.caseIds?.length) {
      rows = sqlite.prepare(`SELECT ${select} FROM "${table}"`).all();
    }

    for (const row of rows) {
      for (const key of storageKeysFromRow(row)) keys.add(key);
    }
  }

  return [...keys];
}
