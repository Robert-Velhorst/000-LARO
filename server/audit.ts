import { nanoid } from "nanoid";
import { and, desc, eq } from "drizzle-orm";
import { auditLogs, InsertAuditLog } from "./schema";
import { getDb } from "./db";

export async function createAuditLog(log: {
  userId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[Audit] Cannot create audit log: database not available");
    return;
  }

  try {
    const auditLog: InsertAuditLog = {
      id: nanoid(),
      userId: log.userId,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      details: log.details ? JSON.stringify(log.details) : null,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
    };

    await db.insert(auditLogs).values(auditLog);
  } catch (error) {
    console.error("[Audit] Failed to create audit log:", error);
  }
}

export async function getAuditLogs(options: {
  userId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  limit?: number;
}) {
  const db = await getDb();
  if (!db) {
    console.warn("[Audit] Cannot get audit logs: database not available");
    return [];
  }

  try {
    // Phase 019: actually apply the filters (previously ignored). Ownership is
    // enforced by callers passing the authenticated userId.
    const conditions = [];
    if (options.userId) conditions.push(eq(auditLogs.userId, options.userId));
    if (options.entityType) conditions.push(eq(auditLogs.entityType, options.entityType));
    if (options.entityId) conditions.push(eq(auditLogs.entityId, options.entityId));
    if (options.action) conditions.push(eq(auditLogs.action, options.action));

    const base = db.select().from(auditLogs);
    const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
    const results = await filtered
      .orderBy(desc(auditLogs.createdAt))
      .limit(options.limit || 100);

    return results.map((log) => ({
      ...log,
      details: log.details ? JSON.parse(log.details) : null,
    }));
  } catch (error) {
    console.error("[Audit] Failed to get audit logs:", error);
    return [];
  }
}

// Audit action constants
export const AUDIT_ACTIONS = {
  // Case actions
  CASE_CREATED: "case.created",
  CASE_UPDATED: "case.updated",
  CASE_DELETED: "case.deleted",
  CASE_STATUS_CHANGED: "case.status_changed",
  
  // Lawyer actions
  LAWYER_CREATED: "lawyer.created",
  LAWYER_UPDATED: "lawyer.updated",
  LAWYER_DELETED: "lawyer.deleted",
  
  // Email actions
  EMAIL_SENT: "email.sent",
  EMAIL_RESPONSE_RECEIVED: "email.response_received",

  // Provider connection actions
  PROVIDER_CONNECTED: "provider.connected",
  PROVIDER_DISCONNECTED: "provider.disconnected",
  PROVIDER_DISCONNECT_REVOKED: "provider.disconnect_revoked",
  PROVIDER_DISCONNECT_FAILED: "provider.disconnect_failed",

  // Evidence actions
  EVIDENCE_EXPORTED: "evidence.exported",
  EVIDENCE_SCORED: "evidence.scored",
  EVIDENCE_SOURCE_OPENED: "evidence.source_opened",
  
  // Outreach actions
  OUTREACH_INITIATED: "outreach.initiated",
  OUTREACH_FOLLOW_UP: "outreach.follow_up",
  OUTREACH_STATUS_CHANGED: "outreach.status_changed",
  OUTREACH_DISPATCH_RESOLVED: "outreach.dispatch_resolved",
  
  // System actions
  USER_LOGIN: "user.login",
  USER_LOGOUT: "user.logout",
  SETTINGS_CHANGED: "settings.changed",
  SCRAPER_RUN: "scraper.run",
} as const;

