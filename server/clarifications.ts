import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { AUDIT_ACTIONS, writeAuditLogOrThrow } from "./audit";
import { getDb } from "./db";
import { findCaseLawyersWithOfficialDirectory } from "./matching";
import {
  cases,
  clarificationQuestions,
  communications,
  deadlines,
} from "./schema";

export const CLARIFICATION_KINDS = [
  "primary_legal_area",
  "location",
  "preferred_language",
  "deadline",
  "budget",
  "contact_email",
  "note",
] as const;

export type ClarificationKind = (typeof CLARIFICATION_KINDS)[number];

type ClarificationContext = {
  guidance?: string;
  choices?: string[];
  targetField?: string;
  source?: string;
};

export type PendingClarification = {
  id: string;
  caseId: string;
  kind: ClarificationKind;
  question: string;
  context: string;
  choices: string[];
  canUpdateCase: boolean;
  affectsMatching: boolean;
};

export type ClarificationAnswerResult = {
  ok: true;
  resolved: string;
  caseId: string;
  kind: ClarificationKind;
  applied: boolean;
  outcome: string;
  reviewStatus: "applied" | "needs_review" | "legacy";
  affectedDerived: "lawyer_matching" | "outreach" | "deadlines" | "none";
  matchingRecomputed: boolean;
  matchingResultCount: number | null;
  message: string;
};

export class ClarificationContractError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST",
  ) {
    super(message);
    this.name = "ClarificationContractError";
  }
}

const answerSchema = z.string().trim().min(1).max(2_000);
const emailSchema = z.string().trim().email().max(254);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function safeObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseContext(value: string | null | undefined): ClarificationContext {
  const parsed = safeObject(value);
  return {
    guidance: typeof parsed.guidance === "string" ? parsed.guidance : undefined,
    choices: Array.isArray(parsed.choices) ? parsed.choices.map(String).filter(Boolean) : undefined,
    targetField: typeof parsed.targetField === "string" ? parsed.targetField : undefined,
    source: typeof parsed.source === "string" ? parsed.source : undefined,
  };
}

function parseStringList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function inferKind(id: string, value: string | null | undefined): ClarificationKind {
  if (CLARIFICATION_KINDS.includes(value as ClarificationKind)) return value as ClarificationKind;
  if (id.endsWith(":primary-area")) return "primary_legal_area";
  if (id.endsWith(":contact")) return "contact_email";
  return "note";
}

function kindCapabilities(kind: ClarificationKind): {
  canUpdateCase: boolean;
  affectsMatching: boolean;
  affectedDerived: ClarificationAnswerResult["affectedDerived"];
} {
  if (["primary_legal_area", "location", "preferred_language", "budget"].includes(kind)) {
    return { canUpdateCase: true, affectsMatching: true, affectedDerived: "lawyer_matching" };
  }
  if (kind === "contact_email") {
    return { canUpdateCase: true, affectsMatching: false, affectedDerived: "outreach" };
  }
  if (kind === "deadline") {
    return { canUpdateCase: true, affectsMatching: false, affectedDerived: "deadlines" };
  }
  return { canUpdateCase: false, affectsMatching: false, affectedDerived: "none" };
}

function questionView(row: {
  id: string;
  caseId: string | null;
  kind: string | null;
  question: string | null;
  context: string | null;
}): PendingClarification | null {
  if (!row.caseId || !row.question) return null;
  const kind = inferKind(row.id, row.kind);
  const context = parseContext(row.context);
  const capabilities = kindCapabilities(kind);
  return {
    id: row.id,
    caseId: row.caseId,
    kind,
    question: row.question,
    context: context.guidance ?? "Answer will be stored with this case and applied only when it passes validation.",
    choices: context.choices ?? [],
    canUpdateCase: capabilities.canUpdateCase,
    affectsMatching: capabilities.affectsMatching,
  };
}

function generatedQuestions(caseRow: {
  id: string;
  userId: string;
  clientEmail: string | null;
  legalAreas: string | null;
}): Array<PendingClarification & { contextJson: string }> {
  const result: Array<PendingClarification & { contextJson: string }> = [];
  const areas = parseStringList(caseRow.legalAreas);
  if (areas.length > 1) {
    const context: ClarificationContext = {
      guidance: "Choose one of the listed legal areas. A valid choice narrows lawyer matching; the other classifications remain in provenance.",
      choices: areas,
      targetField: "cases.legalAreas",
      source: "case_state",
    };
    result.push({
      id: `${caseRow.id}:primary-area`,
      caseId: caseRow.id,
      kind: "primary_legal_area",
      question: `This case matches multiple legal areas (${areas.join(", ")}). Which is the primary area for lawyer matching?`,
      context: context.guidance!,
      choices: areas,
      canUpdateCase: true,
      affectsMatching: true,
      contextJson: JSON.stringify(context),
    });
  }
  if (!caseRow.clientEmail?.trim()) {
    const context: ClarificationContext = {
      guidance: "Enter a valid client email. Invalid text is retained as a review note and does not change outreach data.",
      targetField: "cases.clientEmail",
      source: "case_state",
    };
    result.push({
      id: `${caseRow.id}:contact`,
      caseId: caseRow.id,
      kind: "contact_email",
      question: "This case has no client contact email. Which verified email address should be used for this case?",
      context: context.guidance!,
      choices: [],
      canUpdateCase: true,
      affectsMatching: false,
      contextJson: JSON.stringify(context),
    });
  }
  return result;
}

export async function getPendingClarifications(userId: string): Promise<PendingClarification[]> {
  const db = await getDb();
  if (!db) return [];
  const [caseRows, storedRows] = await Promise.all([
    db.select({
      id: cases.id,
      userId: cases.userId,
      clientEmail: cases.clientEmail,
      legalAreas: cases.legalAreas,
    }).from(cases).where(eq(cases.userId, userId)),
    db.select().from(clarificationQuestions).where(eq(clarificationQuestions.userId, userId)),
  ]);

  const now = new Date();
  const storedById = new Map(storedRows.map((row) => [row.id, row]));
  const generated = caseRows.flatMap(generatedQuestions);
  const desiredIds = new Set(generated.map((question) => question.id));
  const caseIds = new Set(caseRows.map((row) => row.id));

  for (const question of generated) {
    const previous = storedById.get(question.id);
    if (!previous) {
      db.insert(clarificationQuestions).values({
        id: question.id,
        caseId: question.caseId,
        userId,
        kind: question.kind,
        question: question.question,
        context: question.contextJson,
        status: "pending",
        reviewStatus: "pending",
        provenance: JSON.stringify({ source: "case_state", generatedAt: now.toISOString() }),
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run();
    } else if (!previous.status || previous.status === "pending" || previous.status === "obsolete") {
      db.update(clarificationQuestions).set({
        kind: question.kind,
        question: question.question,
        context: question.contextJson,
        status: "pending",
        reviewStatus: "pending",
        updatedAt: now,
      }).where(and(
        eq(clarificationQuestions.id, question.id),
        eq(clarificationQuestions.userId, userId),
      )).run();
    }
  }

  for (const row of storedRows) {
    const generatedKind = row.id.endsWith(":primary-area") || row.id.endsWith(":contact");
    if (generatedKind && (!row.status || row.status === "pending") && !desiredIds.has(row.id)) {
      db.update(clarificationQuestions).set({ status: "obsolete", updatedAt: now }).where(and(
        eq(clarificationQuestions.id, row.id),
        eq(clarificationQuestions.userId, userId),
      )).run();
    }
  }

  const generatedViews = generated.filter((question) => {
    const row = storedById.get(question.id);
    return !row || !row.status || row.status === "pending" || row.status === "obsolete";
  }).map(({ contextJson: _contextJson, ...question }) => question);
  const customViews = storedRows
    .filter((row) => (!row.status || row.status === "pending") && !desiredIds.has(row.id) && Boolean(row.caseId && caseIds.has(row.caseId)))
    .map(questionView)
    .filter((row): row is PendingClarification => Boolean(row));

  return [...generatedViews, ...customViews].sort((a, b) => a.id.localeCompare(b.id));
}

function noteId(questionId: string): string {
  return `CLARIFICATION-NOTE-${createHash("sha256").update(questionId).digest("hex").slice(0, 24)}`;
}

function deadlineId(questionId: string): string {
  return `CLARIFICATION-DEADLINE-${createHash("sha256").update(questionId).digest("hex").slice(0, 24)}`;
}

function parseLanguages(answer: string): string[] | null {
  const values = [...new Set(answer.split(/[,;]/).map((value) => value.trim()).filter(Boolean))];
  if (!values.length || values.length > 5) return null;
  if (values.some((value) => value.length > 50 || !/^[\p{L}][\p{L}\p{M}\s-]*$/u.test(value))) return null;
  return values;
}

function parseBudgetPreference(answer: string): boolean | null {
  const normalized = answer.toLowerCase().replace(/[.!?]/g, "").trim();
  if (["yes", "ja", "legal aid", "financed legal aid", "subsidized legal aid", "toevoeging"].includes(normalized)) return true;
  if (["no", "nee", "private funding", "self funded", "self-funded", "private pay"].includes(normalized)) return false;
  return null;
}

function validIsoDate(answer: string): Date | null {
  if (!isoDateSchema.safeParse(answer).success) return null;
  const date = new Date(`${answer}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== answer ? null : date;
}

export async function answerClarification(options: {
  userId: string;
  questionId: string;
  answer: string;
}): Promise<ClarificationAnswerResult> {
  const parsedAnswer = answerSchema.safeParse(options.answer);
  if (!parsedAnswer.success) {
    throw new ClarificationContractError("Answer must contain between 1 and 2,000 characters.", "BAD_REQUEST");
  }
  const answer = parsedAnswer.data;
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const decision = db.transaction((tx) => {
    const row = tx.select().from(clarificationQuestions).where(and(
      eq(clarificationQuestions.id, options.questionId),
      eq(clarificationQuestions.userId, options.userId),
    )).get();
    if (!row || !row.caseId || !row.question) {
      throw new ClarificationContractError("Clarification question not found.", "NOT_FOUND");
    }
    const caseRow = tx.select().from(cases).where(and(
      eq(cases.id, row.caseId),
      eq(cases.userId, options.userId),
    )).get();
    if (!caseRow) throw new ClarificationContractError("Clarification question not found.", "NOT_FOUND");

    const kind = inferKind(row.id, row.kind);
    const capabilities = kindCapabilities(kind);
    if (row.status === "answered") {
      if (row.answer !== answer) {
        throw new ClarificationContractError("This clarification was already answered.", "CONFLICT");
      }
      return {
        caseId: row.caseId,
        kind,
        applied: row.applied === true,
        outcome: row.outcome || "recorded",
        reviewStatus: (row.reviewStatus || (row.applied ? "applied" : "needs_review")) as ClarificationAnswerResult["reviewStatus"],
        affectedDerived: row.applied ? capabilities.affectedDerived : "none" as const,
        affectsMatching: row.applied === true && capabilities.affectsMatching,
        idempotent: true,
      };
    }

    const now = new Date();
    const previousMetadata = safeObject(caseRow.metadata);
    let applied = false;
    let outcome = "stored_for_review";
    let targetField = parseContext(row.context).targetField ?? null;

    if (kind === "primary_legal_area") {
      const areas = parseStringList(caseRow.legalAreas);
      const selected = areas.find((area) => area.toLowerCase() === answer.toLowerCase());
      if (selected) {
        const previousClarification = previousMetadata.clarification && typeof previousMetadata.clarification === "object"
          ? previousMetadata.clarification as Record<string, unknown>
          : {};
        const metadata = {
          ...previousMetadata,
          clarification: {
            ...previousClarification,
            primaryLegalArea: selected,
            classifiedLegalAreas: areas,
            secondaryLegalAreas: areas.filter((area) => area !== selected),
          },
        };
        tx.update(cases).set({
          caseType: selected,
          legalAreas: JSON.stringify([selected]),
          metadata: JSON.stringify(metadata),
          updatedAt: now,
        }).where(and(eq(cases.id, caseRow.id), eq(cases.userId, options.userId))).run();
        applied = true;
        outcome = "primary_legal_area_applied";
        targetField = "cases.legalAreas";
      } else {
        outcome = "legal_area_not_in_question_choices";
      }
    } else if (kind === "location") {
      const cleanLocation = answer.replace(/\s+/g, " ").trim();
      if (cleanLocation.length >= 2 && cleanLocation.length <= 160 && !/[\u0000-\u001f\u007f]/.test(cleanLocation)) {
        tx.update(cases).set({
          clientAddress: cleanLocation,
          latitude: null,
          longitude: null,
          updatedAt: now,
        }).where(and(eq(cases.id, caseRow.id), eq(cases.userId, options.userId))).run();
        applied = true;
        outcome = "location_applied";
        targetField = "cases.clientAddress";
      } else {
        outcome = "location_requires_review";
      }
    } else if (kind === "preferred_language") {
      const languages = parseLanguages(answer);
      if (languages) {
        tx.update(cases).set({ preferredLanguages: JSON.stringify(languages), updatedAt: now }).where(and(
          eq(cases.id, caseRow.id),
          eq(cases.userId, options.userId),
        )).run();
        applied = true;
        outcome = "preferred_languages_applied";
        targetField = "cases.preferredLanguages";
      } else {
        outcome = "language_requires_review";
      }
    } else if (kind === "deadline") {
      const dueDate = validIsoDate(answer);
      if (dueDate) {
        const id = deadlineId(row.id);
        tx.insert(deadlines).values({
          id,
          caseId: caseRow.id,
          userId: options.userId,
          title: "Clarified case deadline",
          description: `Recorded from clarification: ${row.question}`,
          dueDate,
          completed: false,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: deadlines.id,
          set: { dueDate, description: `Recorded from clarification: ${row.question}`, updatedAt: now },
        }).run();
        applied = true;
        outcome = "deadline_applied";
        targetField = "deadlines.dueDate";
      } else {
        outcome = "deadline_requires_iso_date";
      }
    } else if (kind === "budget") {
      const requiresFinancedLegalAid = parseBudgetPreference(answer);
      if (requiresFinancedLegalAid !== null) {
        const currentPreferences = previousMetadata.matchingPreferences && typeof previousMetadata.matchingPreferences === "object"
          ? previousMetadata.matchingPreferences as Record<string, unknown>
          : {};
        tx.update(cases).set({
          metadata: JSON.stringify({
            ...previousMetadata,
            matchingPreferences: { ...currentPreferences, requiresFinancedLegalAid },
          }),
          updatedAt: now,
        }).where(and(eq(cases.id, caseRow.id), eq(cases.userId, options.userId))).run();
        applied = true;
        outcome = "funding_preference_applied";
        targetField = "cases.metadata.matchingPreferences.requiresFinancedLegalAid";
      } else {
        outcome = "budget_requires_funding_choice";
      }
    } else if (kind === "contact_email") {
      const email = emailSchema.safeParse(answer);
      if (email.success) {
        tx.update(cases).set({ clientEmail: email.data.toLowerCase(), updatedAt: now }).where(and(
          eq(cases.id, caseRow.id),
          eq(cases.userId, options.userId),
        )).run();
        applied = true;
        outcome = "contact_email_applied";
        targetField = "cases.clientEmail";
      } else {
        outcome = "contact_email_requires_review";
      }
    }

    if (!applied) {
      tx.insert(communications).values({
        id: noteId(row.id),
        caseId: caseRow.id,
        userId: options.userId,
        channel: "assistant",
        type: "clarification_note",
        direction: "internal",
        subject: row.question,
        body: answer,
        content: answer,
        timestamp: now,
        metadata: JSON.stringify({ clarificationId: row.id, kind, outcome, applied: false }),
        createdAt: now,
      }).onConflictDoUpdate({
        target: communications.id,
        set: { body: answer, content: answer, timestamp: now, metadata: JSON.stringify({ clarificationId: row.id, kind, outcome, applied: false }) },
      }).run();
    }

    const provenance = {
      source: "assistant_clarification",
      questionId: row.id,
      caseId: caseRow.id,
      actorId: options.userId,
      submittedAt: now.toISOString(),
      targetField,
      applied,
    };
    tx.update(clarificationQuestions).set({
      kind,
      answer,
      answeredBy: options.userId,
      status: "answered",
      applied,
      outcome,
      reviewStatus: applied ? "applied" : "needs_review",
      provenance: JSON.stringify(provenance),
      answeredAt: now,
      updatedAt: now,
    }).where(and(
      eq(clarificationQuestions.id, row.id),
      eq(clarificationQuestions.userId, options.userId),
    )).run();
    writeAuditLogOrThrow(tx, {
      userId: options.userId,
      action: AUDIT_ACTIONS.CASE_CLARIFICATION_ANSWERED,
      entityType: "clarification",
      entityId: row.id,
      details: { caseId: caseRow.id, kind, applied, outcome, targetField },
      idempotencyKey: `clarification:${row.id}:answered`,
    });

    return {
      caseId: caseRow.id,
      kind,
      applied,
      outcome,
      reviewStatus: (applied ? "applied" : "needs_review") as ClarificationAnswerResult["reviewStatus"],
      affectedDerived: applied ? capabilities.affectedDerived : "none" as const,
      affectsMatching: applied && capabilities.affectsMatching,
      idempotent: false,
    };
  });

  let matchingRecomputed = false;
  let matchingResultCount: number | null = null;
  let outcome = decision.outcome;
  let reviewStatus = decision.reviewStatus;
  if (decision.affectsMatching) {
    try {
      const refreshed = await findCaseLawyersWithOfficialDirectory(decision.caseId, {
        maxResults: 50,
        refreshOfficialDirectory: false,
      });
      matchingRecomputed = true;
      matchingResultCount = refreshed.lawyers.length;
      if (outcome.endsWith("_matching_refresh_failed")) outcome = outcome.slice(0, -"_matching_refresh_failed".length);
      reviewStatus = "applied";
      const now = new Date();
      const [stored] = await db.select({ provenance: clarificationQuestions.provenance }).from(clarificationQuestions).where(and(
        eq(clarificationQuestions.id, options.questionId),
        eq(clarificationQuestions.userId, options.userId),
      )).limit(1);
      db.update(clarificationQuestions).set({
        outcome,
        reviewStatus,
        provenance: JSON.stringify({
          ...safeObject(stored?.provenance),
          matchingRefresh: {
            status: "complete",
            completedAt: now.toISOString(),
            resultCount: matchingResultCount,
          },
        }),
        updatedAt: now,
      }).where(and(
        eq(clarificationQuestions.id, options.questionId),
        eq(clarificationQuestions.userId, options.userId),
      )).run();
    } catch (error) {
      outcome = `${decision.outcome}_matching_refresh_failed`;
      reviewStatus = "needs_review";
      const now = new Date();
      const [stored] = await db.select({ provenance: clarificationQuestions.provenance }).from(clarificationQuestions).where(and(
        eq(clarificationQuestions.id, options.questionId),
        eq(clarificationQuestions.userId, options.userId),
      )).limit(1);
      db.update(clarificationQuestions).set({
        outcome,
        reviewStatus,
        provenance: JSON.stringify({
          ...safeObject(stored?.provenance),
          matchingRefresh: {
            status: "failed",
            attemptedAt: now.toISOString(),
            error: error instanceof Error ? error.message.slice(0, 300) : "Matching refresh failed",
          },
        }),
        updatedAt: now,
      }).where(and(
        eq(clarificationQuestions.id, options.questionId),
        eq(clarificationQuestions.userId, options.userId),
      )).run();
    }
  }

  const message = !decision.applied
    ? "Answer saved as a case note for review; case and matching fields were not changed."
    : decision.affectsMatching && !matchingRecomputed
      ? "Case field updated, but matching could not be refreshed and needs review."
      : decision.affectsMatching
        ? "Case field updated and lawyer matching refreshed."
        : "Case field updated from the clarification answer.";
  return {
    ok: true,
    resolved: options.questionId,
    caseId: decision.caseId,
    kind: decision.kind,
    applied: decision.applied,
    outcome,
    reviewStatus,
    affectedDerived: decision.affectedDerived,
    matchingRecomputed,
    matchingResultCount,
    message,
  };
}

export async function createClarificationQuestion(input: {
  userId: string;
  caseId: string;
  kind: ClarificationKind;
  question: string;
  context?: ClarificationContext;
}): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [ownedCase] = await db.select({ id: cases.id }).from(cases).where(and(
    eq(cases.id, input.caseId),
    eq(cases.userId, input.userId),
  )).limit(1);
  if (!ownedCase) throw new ClarificationContractError("Case not found.", "NOT_FOUND");
  const id = `CLARIFY-${nanoid(18)}`;
  const now = new Date();
  await db.insert(clarificationQuestions).values({
    id,
    userId: input.userId,
    caseId: input.caseId,
    kind: input.kind,
    question: input.question.trim().slice(0, 2_000),
    context: JSON.stringify(input.context ?? { source: "internal" }),
    status: "pending",
    reviewStatus: "pending",
    provenance: JSON.stringify({ source: input.context?.source ?? "internal", generatedAt: now.toISOString() }),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
