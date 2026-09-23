import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClarificationQuestion } from "../../server/clarifications";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildLawyer, buildUser } from "../factories";

const suite = sqliteAvailable ? describe : describe.skip;

suite("typed clarification application", () => {
  let app: TestApp;
  const owner = buildUser({ id: "CLARIFICATION_OWNER", email: "clarification-owner@example.test" });
  const intruder = buildUser({ id: "CLARIFICATION_INTRUDER", email: "clarification-intruder@example.test" });

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([owner, intruder]);
  });

  afterAll(() => app?.cleanup());

  it("persists a primary-area answer, narrows the canonical matching input, and refreshes only owned matching", async () => {
    const caseId = "CLARIFICATION_PRIMARY_CASE";
    await app.db.insert(app.schema.cases).values(buildCase({
      id: caseId,
      userId: owner.id,
      clientEmail: "client@example.test",
      legalAreas: JSON.stringify(["Employment Law", "Administrative Law"]),
    }));
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({ id: "CLARIFICATION_EMPLOYMENT_LAWYER", legalAreas: JSON.stringify(["Employment Law"]) }),
      buildLawyer({ id: "CLARIFICATION_ADMIN_LAWYER", legalAreas: JSON.stringify(["Administrative Law"]) }),
    ]);

    const caller = app.makeCaller(owner);
    const question = (await caller.clarifications.pending()).find((row: any) => row.id === `${caseId}:primary-area`);
    expect(question).toMatchObject({
      kind: "primary_legal_area",
      choices: ["Employment Law", "Administrative Law"],
      canUpdateCase: true,
      affectsMatching: true,
    });
    await expect(app.makeCaller(intruder).clarifications.answer({
      questionId: question.id,
      answer: "Administrative Law",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const result = await caller.clarifications.answer({
      questionId: question.id,
      answer: "Administrative Law",
    });
    expect(result).toMatchObject({
      ok: true,
      applied: true,
      outcome: "primary_legal_area_applied",
      affectedDerived: "lawyer_matching",
      matchingRecomputed: true,
      matchingResultCount: 1,
      reviewStatus: "applied",
    });

    const [caseRow] = await app.db.select().from(app.schema.cases).where(eq(app.schema.cases.id, caseId));
    expect(JSON.parse(caseRow.legalAreas)).toEqual(["Administrative Law"]);
    expect(caseRow.caseType).toBe("Administrative Law");
    expect(JSON.parse(caseRow.metadata)).toMatchObject({
      clarification: {
        primaryLegalArea: "Administrative Law",
        classifiedLegalAreas: ["Employment Law", "Administrative Law"],
        secondaryLegalAreas: ["Employment Law"],
      },
    });

    const [stored] = await app.db.select().from(app.schema.clarificationQuestions).where(eq(app.schema.clarificationQuestions.id, question.id));
    expect(stored).toMatchObject({
      caseId,
      userId: owner.id,
      kind: "primary_legal_area",
      answer: "Administrative Law",
      answeredBy: owner.id,
      status: "answered",
      applied: true,
      outcome: "primary_legal_area_applied",
      reviewStatus: "applied",
    });
    expect(stored.question).toContain("primary area");
    expect(stored.answeredAt).toBeInstanceOf(Date);
    expect(JSON.parse(stored.provenance)).toMatchObject({ actorId: owner.id, caseId, applied: true });

    const matches = await caller.matching.findLawyers({ caseId, maxResults: 10 });
    expect(matches.map((match: any) => match.id)).toEqual(["CLARIFICATION_ADMIN_LAWYER"]);
    const [audit] = await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.userId, owner.id),
      eq(app.schema.auditLogs.entityId, question.id),
    ));
    expect(audit?.action).toBe("case.clarification_answered");
    expect(audit?.details).not.toContain("Administrative Law");
  });

  it("stores an invalid contact answer as a review note without claiming a case update", async () => {
    const caseId = "CLARIFICATION_REVIEW_CASE";
    await app.db.insert(app.schema.cases).values(buildCase({
      id: caseId,
      userId: owner.id,
      clientEmail: null,
      legalAreas: JSON.stringify(["Employment Law"]),
    }));
    const caller = app.makeCaller(owner);
    const question = (await caller.clarifications.pending()).find((row: any) => row.id === `${caseId}:contact`);
    const result = await caller.clarifications.answer({ questionId: question.id, answer: "resolved" });
    expect(result).toMatchObject({
      applied: false,
      outcome: "contact_email_requires_review",
      affectedDerived: "none",
      matchingRecomputed: false,
      reviewStatus: "needs_review",
    });
    expect(result.message).toContain("not changed");

    const [caseRow] = await app.db.select().from(app.schema.cases).where(eq(app.schema.cases.id, caseId));
    expect(caseRow.clientEmail).toBeNull();
    const [note] = await app.db.select().from(app.schema.communications).where(and(
      eq(app.schema.communications.caseId, caseId),
      eq(app.schema.communications.type, "clarification_note"),
    ));
    expect(note).toMatchObject({ userId: owner.id, subject: question.question, body: "resolved" });
    expect((await caller.clarifications.pending()).find((row: any) => row.id === question.id)).toBeUndefined();

    await expect(caller.clarifications.answer({ questionId: question.id, answer: "different" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.clarifications.answer({ questionId: question.id, answer: "resolved" }))
      .resolves.toMatchObject({ applied: false, affectedDerived: "none" });
  });

  it("applies a validated contact email to the owned case", async () => {
    const caseId = "CLARIFICATION_CONTACT_CASE";
    await app.db.insert(app.schema.cases).values(buildCase({
      id: caseId,
      userId: owner.id,
      clientEmail: null,
      legalAreas: JSON.stringify(["Employment Law"]),
    }));
    const caller = app.makeCaller(owner);
    const question = (await caller.clarifications.pending()).find((row: any) => row.id === `${caseId}:contact`);
    const result = await caller.clarifications.answer({ questionId: question.id, answer: "Client@Example.test" });
    expect(result).toMatchObject({ applied: true, outcome: "contact_email_applied", affectedDerived: "outreach" });
    const [caseRow] = await app.db.select().from(app.schema.cases).where(eq(app.schema.cases.id, caseId));
    expect(caseRow.clientEmail).toBe("client@example.test");
  });

  it("maps typed location, language, funding, and deadline answers to their canonical fields", async () => {
    const caseId = "CLARIFICATION_TYPED_CASE";
    await app.db.insert(app.schema.cases).values(buildCase({
      id: caseId,
      userId: owner.id,
      clientEmail: "typed@example.test",
      clientAddress: null,
      latitude: "52.1",
      longitude: "4.3",
      preferredLanguages: null,
      metadata: null,
      legalAreas: JSON.stringify(["Employment Law"]),
    }));
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({
        id: "CLARIFICATION_AID_DUTCH_LAWYER",
        legalAreas: JSON.stringify(["Employment Law"]),
        languages: JSON.stringify(["Dutch"]),
        financedLegalAid: "Yes",
        directorySearchLocation: "Utrecht",
        directoryDistanceKm: 8,
      }),
      buildLawyer({
        id: "CLARIFICATION_PRIVATE_ENGLISH_LAWYER",
        legalAreas: JSON.stringify(["Employment Law"]),
        languages: JSON.stringify(["English"]),
        financedLegalAid: "No",
        directorySearchLocation: "Utrecht",
        directoryDistanceKm: 8,
      }),
    ]);

    const locationId = await createClarificationQuestion({
      userId: owner.id,
      caseId,
      kind: "location",
      question: "Which location should lawyer matching use?",
      context: { targetField: "cases.clientAddress", source: "test" },
    });
    const languageId = await createClarificationQuestion({
      userId: owner.id,
      caseId,
      kind: "preferred_language",
      question: "Which language must the lawyer speak?",
      context: { targetField: "cases.preferredLanguages", source: "test" },
    });
    const budgetId = await createClarificationQuestion({
      userId: owner.id,
      caseId,
      kind: "budget",
      question: "Is financed legal aid required?",
      context: { choices: ["Yes", "No"], targetField: "cases.metadata.matchingPreferences.requiresFinancedLegalAid", source: "test" },
    });
    const deadlineQuestionId = await createClarificationQuestion({
      userId: owner.id,
      caseId,
      kind: "deadline",
      question: "What is the verified deadline (YYYY-MM-DD)?",
      context: { targetField: "deadlines.dueDate", source: "test" },
    });

    const caller = app.makeCaller(owner);
    await expect(caller.clarifications.answer({ questionId: locationId, answer: "Utrecht" }))
      .resolves.toMatchObject({ applied: true, outcome: "location_applied", matchingRecomputed: true });
    await expect(caller.clarifications.answer({ questionId: languageId, answer: "Dutch" }))
      .resolves.toMatchObject({ applied: true, outcome: "preferred_languages_applied", matchingRecomputed: true, matchingResultCount: 1 });
    await expect(caller.clarifications.answer({ questionId: budgetId, answer: "Yes" }))
      .resolves.toMatchObject({ applied: true, outcome: "funding_preference_applied", matchingRecomputed: true, matchingResultCount: 1 });
    await expect(caller.clarifications.answer({ questionId: deadlineQuestionId, answer: "2026-12-15" }))
      .resolves.toMatchObject({ applied: true, outcome: "deadline_applied", affectedDerived: "deadlines", matchingRecomputed: false });

    const [caseRow] = await app.db.select().from(app.schema.cases).where(eq(app.schema.cases.id, caseId));
    expect(caseRow).toMatchObject({ clientAddress: "Utrecht", latitude: null, longitude: null });
    expect(JSON.parse(caseRow.preferredLanguages)).toEqual(["Dutch"]);
    expect(JSON.parse(caseRow.metadata)).toMatchObject({ matchingPreferences: { requiresFinancedLegalAid: true } });
    const [deadline] = await app.db.select().from(app.schema.deadlines).where(eq(app.schema.deadlines.caseId, caseId));
    expect(deadline).toMatchObject({ userId: owner.id, title: "Clarified case deadline", completed: false });
    expect(deadline.dueDate.toISOString().slice(0, 10)).toBe("2026-12-15");

    const matches = await caller.matching.findLawyers({ caseId, maxResults: 10 });
    expect(matches.map((match: any) => match.id)).toEqual(["CLARIFICATION_AID_DUTCH_LAWYER"]);
  });
});
