import { afterEach, expect, it, vi } from "vitest";
import { writeAuditLogOrThrow } from "../../server/audit";

afterEach(() => vi.useRealTimers());

it("assigns audit timestamps at the moment of each event, not schema initialization", () => {
  const rows: Array<{ createdAt?: Date }> = [];
  const db = { insert: () => ({ values: (row: { createdAt?: Date }) => ({ run: () => rows.push(row) }) }) };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T09:00:00Z"));
  writeAuditLogOrThrow(db, { userId: "owner", action: "inbox.organized" });
  vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
  writeAuditLogOrThrow(db, { userId: "owner", action: "inbox.organized" });
  expect(rows.map((row) => row.createdAt?.toISOString())).toEqual(["2026-09-05T09:00:00.000Z", "2026-09-05T10:00:00.000Z"]);
});
