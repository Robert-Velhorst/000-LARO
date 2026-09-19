export const NOTIFICATION_KINDS = [
  "lawyer_response",
  "case_status_change",
  "evidence_uploaded",
  "new_match",
  "deadline_reminder",
  "system_announcement",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationContext {
  caseId?: string | null;
  lawyerId?: string | null;
  evidenceFileId?: string | null;
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/**
 * The only internal destinations a persisted notification may open.
 *
 * Keep this registry aligned with DashboardApp routes and the query parameters
 * consumed by Cases/Evidence. Callers provide context, never an arbitrary URL.
 */
export function buildNotificationDestination(
  kind: NotificationKind,
  context: NotificationContext,
): string | null {
  switch (kind) {
    case "lawyer_response":
    case "case_status_change":
    case "deadline_reminder":
      return context.caseId ? `/cases?case=${encodeURIComponent(context.caseId)}` : null;
    case "evidence_uploaded":
      return context.caseId && context.evidenceFileId
        ? `/evidence?view=items&case=${encodeURIComponent(context.caseId)}&evidence=${encodeURIComponent(context.evidenceFileId)}`
        : null;
    case "new_match":
      return context.lawyerId ? `/lawyers/${encodeURIComponent(context.lawyerId)}` : null;
    case "system_announcement":
      return null;
  }
}

export function isRegisteredNotificationDestination(
  destination: unknown,
  kind: NotificationKind,
  context: NotificationContext,
): destination is string {
  const registered = buildNotificationDestination(kind, context);
  return registered !== null && destination === registered;
}
