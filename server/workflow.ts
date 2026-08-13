import { nanoid } from "nanoid";
import { getDb } from "./db";
import { cases, outreachStatus, emailActivity } from "./schema";
import { eq, and } from "drizzle-orm";
import { createAuditLog, AUDIT_ACTIONS } from "./audit";
import { getNextLawyerToContact } from "./matching";

/**
 * Business hours configuration
 */
export const BUSINESS_HOURS = {
  start: 9, // 9 AM
  end: 17, // 5 PM
  timezone: "Europe/Amsterdam",
};

/**
 * Follow-up configuration
 */
export const FOLLOW_UP_CONFIG = {
  intervals: [3, 7, 14], // Days between follow-ups
  maxFollowUps: 3,
  escalateAfterDays: 21, // Move to next lawyer after 3 weeks
};

/**
 * Check if current time is within business hours
 */
export function isBusinessHours(date: Date = new Date()): boolean {
  const hour = date.getHours();
  const day = date.getDay();
  
  // Skip weekends (0 = Sunday, 6 = Saturday)
  if (day === 0 || day === 6) return false;
  
  // Check if within business hours
  return hour >= BUSINESS_HOURS.start && hour < BUSINESS_HOURS.end;
}

/**
 * Calculate next business day time for scheduling
 */
export function getNextBusinessHourSlot(daysFromNow: number = 0): Date {
  const now = new Date();
  const target = new Date(now);
  target.setDate(target.getDate() + daysFromNow);
  
  // Set to start of business hours
  target.setHours(BUSINESS_HOURS.start, 0, 0, 0);
  
  // Skip weekends
  while (target.getDay() === 0 || target.getDay() === 6) {
    target.setDate(target.getDate() + 1);
  }
  
  return target;
}

/**
 * Initiate outreach for a case
 * Finds matching lawyers and creates outreach records
 */
export async function initiateOutreach(caseId: string, userId?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Get next lawyer to contact
  const lawyer = await getNextLawyerToContact(caseId, []);
  
  if (!lawyer) {
    throw new Error("No matching lawyers found for this case");
  }

  // Create a reviewable draft. This helper must never imply that an external
  // message was sent; transmission is owned by sendApprovedOutreach().
  const outreachId = nanoid();
  await db.insert(outreachStatus).values({
    id: outreachId,
    caseId,
    lawyerId: lawyer.id,
    status: "PendingApproval",
    followUpsSent: 0,
    distanceKm: Math.round(lawyer.distance),
  });

  // Update case status
  await db
    .update(cases)
    .set({ status: "Outreach" })
    .where(eq(cases.id, caseId));

  // Log the action
  await createAuditLog({
    userId,
    action: AUDIT_ACTIONS.OUTREACH_INITIATED,
    entityType: "outreach",
    entityId: outreachId,
    details: {
      caseId,
      lawyerId: lawyer.id,
      lawyerName: lawyer.name,
      distance: lawyer.distance,
      status: "PendingApproval",
      externalMessageSent: false,
    },
  });

  return {
    outreachId,
    lawyer,
    scheduledTime: null,
    sent: false,
  };
}

/**
 * Process follow-ups for cases with no response
 */
export async function processFollowUps() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Only send follow-ups during business hours
  if (!isBusinessHours()) {
    console.log("[Workflow] Outside business hours, skipping follow-ups");
    return { processed: 0, scheduled: 0 };
  }

  const results = await db
    .select()
    .from(outreachStatus)
    .where(eq(outreachStatus.status, "Contacted"));

  let processed = 0;
  let scheduled = 0;

  for (const outreach of results) {
    const followUpCount = Number(outreach.followUpsSent || 0);
    
    // Check if max follow-ups reached
    if (followUpCount >= FOLLOW_UP_CONFIG.maxFollowUps) {
      // Escalate to next lawyer
      if (outreach.caseId && outreach.lawyerId) {
        await escalateToNextLawyer(outreach.caseId, outreach.lawyerId);
      }
      processed++;
      continue;
    }

    // Calculate days since last contact
    const lastContact = outreach.lastContact || outreach.initialContact;
    if (!lastContact) continue;

    const daysSinceContact = Math.floor(
      (Date.now() - lastContact.getTime()) / (1000 * 60 * 60 * 24)
    );

    // Check if it's time for next follow-up
    const nextInterval = FOLLOW_UP_CONFIG.intervals[followUpCount];
    if (daysSinceContact >= nextInterval) {
      // Send follow-up
      await db.insert(emailActivity).values({
        id: nanoid(),
        lawyerId: outreach.lawyerId,
        caseId: outreach.caseId,
        activityType: "Follow-up",
        subject: `Follow-up: Legal Case Opportunity`,
        sentAt: new Date(),
        responseReceived: "No",
        responseStatus: "No Response",
      } as any);

      // Update outreach record
      await db
        .update(outreachStatus)
        .set({
          lastContact: new Date(),
          followUpsSent: followUpCount + 1,
        })
        .where(eq(outreachStatus.id, outreach.id));

      await createAuditLog({
        action: AUDIT_ACTIONS.OUTREACH_FOLLOW_UP,
        entityType: "outreach",
        entityId: outreach.id,
        details: {
          caseId: outreach.caseId,
          lawyerId: outreach.lawyerId,
          followUpNumber: followUpCount + 1,
        },
      });

      processed++;
    } else {
      scheduled++;
    }
  }

  return { processed, scheduled };
}

/**
 * Escalate case to next available lawyer
 */
export async function escalateToNextLawyer(caseId: string, currentLawyerId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Mark current outreach as "No Response"
  await db
    .update(outreachStatus)
    .set({ status: "No Response" })
    .where(
      and(
        eq(outreachStatus.caseId, caseId),
        eq(outreachStatus.lawyerId, currentLawyerId)
      )
    );

  // Get all previously contacted lawyers
  const previousOutreach = await db
    .select()
    .from(outreachStatus)
    .where(eq(outreachStatus.caseId, caseId));

  const contactedIds = previousOutreach.map(o => o.lawyerId).filter((id): id is string => id !== null);

  // Find next lawyer
  const nextLawyer = await getNextLawyerToContact(caseId, contactedIds);

  if (!nextLawyer) {
    // No more lawyers available
    await db
      .update(cases)
      .set({ status: "Closed" })
      .where(eq(cases.id, caseId));

    await createAuditLog({
      action: AUDIT_ACTIONS.CASE_STATUS_CHANGED,
      entityType: "case",
      entityId: caseId,
      details: {
        newStatus: "Closed",
        reason: "No more matching lawyers available",
      },
    });

    return null;
  }

  // Initiate outreach to next lawyer
  return await initiateOutreach(caseId);
}

/**
 * Handle lawyer response
 */
export async function handleLawyerResponse(
  outreachId: string,
  response: "Interested" | "Declined",
  notes?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Get outreach record
  const outreach = await db
    .select()
    .from(outreachStatus)
    .where(eq(outreachStatus.id, outreachId))
    .limit(1);

  if (outreach.length === 0) {
    throw new Error("Outreach record not found");
  }

  const record = outreach[0];

  // Update outreach status
  await db
    .update(outreachStatus)
    .set({
      status: response,
      response: notes || null,
      updatedAt: new Date(),
    })
    .where(eq(outreachStatus.id, outreachId));

  // Update email activity
  if (record.caseId && record.lawyerId) {
    await db
      .update(emailActivity)
      .set({
        responseReceived: "Yes",
        responseStatus: response,
      })
      .where(
        and(
          eq(emailActivity.caseId, record.caseId),
          eq(emailActivity.lawyerId, record.lawyerId)
        )
      );
  }

  if (response === "Interested" && record.caseId) {
    // Update case status to Matched
    await db
      .update(cases)
      .set({ status: "Matched" })
      .where(eq(cases.id, record.caseId as string));

    // Create audit log for the case
    await createAuditLog({
      action: AUDIT_ACTIONS.CASE_STATUS_CHANGED,
      entityType: "case",
      entityId: record.caseId as string,
      details: {
        newStatus: "Matched",
      },
    });
  } else if (record.caseId && record.lawyerId) {
    // Escalate to next lawyer if response was a decline OR we need more matches
    // Note: Escalate is called for declines, or for "Interested" if needed
    console.log(`[Workflow] Escalating case ${record.caseId} from lawyer ${record.lawyerId}`);
    await escalateToNextLawyer(record.caseId as string, record.lawyerId as string);
  }

  await createAuditLog({
    action: AUDIT_ACTIONS.EMAIL_RESPONSE_RECEIVED,
    entityType: "outreach",
    entityId: outreachId,
    details: {
      caseId: record.caseId,
      lawyerId: record.lawyerId,
      response,
      notes,
    },
  });

  return { success: true, response };
}

/**
 * Get workflow statistics
 */
export async function getWorkflowStats() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const allOutreach = await db.select().from(outreachStatus);
  const allEmails = await db.select().from(emailActivity);

  const stats = {
    totalOutreach: allOutreach.length,
    contacted: allOutreach.filter(o => o.status === "Contacted").length,
    interested: allOutreach.filter(o => o.status === "Interested").length,
    declined: allOutreach.filter(o => o.status === "Declined").length,
    noResponse: allOutreach.filter(o => o.status === "No Response").length,
    totalEmails: allEmails.length,
    responseRate: 0,
    averageResponseTime: 0,
  };

  if (stats.totalOutreach > 0) {
    stats.responseRate = Math.round(
      ((stats.interested + stats.declined) / stats.totalOutreach) * 100
    );
  }

  return stats;
}

