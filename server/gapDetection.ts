import { getDb } from "./db";
import {
  communicationGaps,
  expectedDocuments,
  suspiciousPatterns,
  legalInferences,
  caseStrengthAnalysis,
  communications,
  timeline,
  cases,
  evidence,
  evidenceFiles,
  emailAccounts,
} from "./schema";
import { eq, asc } from "drizzle-orm";
import { nanoid } from "nanoid";

interface TimelineEvent {
  id: string;
  date: Date;
  type: string;
  title: string;
  description?: string;
  direction?: "inbound" | "outbound";
  hasDocumentation: boolean;
  participants?: string[];
}

export interface GapAnalysisResult {
  gaps: CommunicationGap[];
  expectedDocs: ExpectedDocument[];
  patterns: SuspiciousPattern[];
  inferences: LegalInference[];
  caseStrength: {
    overallScore: number;
    directEvidenceScore: number;
    circumstantialEvidenceScore: number;
    legalBasisScore: number;
    gapAnalysisImpact: number;
    strengths: string[];
    weaknesses: string[];
    recommendations: string[];
    narrative: string;
  };
}

interface CommunicationGap {
  id: string;
  caseId: string;
  gapType: string;
  startDate: Date;
  endDate: Date | null;
  durationDays: string;
  context: string;
  significance: string;
  precedingEvents: string;
  legalImplications: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ExpectedDocument {
  id: string;
  caseId: string;
  gapId: string | null;
  documentType: string;
  reason: string;
  legalRequirement: boolean;
  legalBasis: string | null;
  deadline: Date | null;
  status: "missing" | "delayed" | "incomplete" | "received";
  receivedAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SuspiciousPattern {
  id: string;
  caseId: string;
  patternType: string;
  description: string;
  evidenceIds: string;
  legalSignificance: string;
  confidence: string;
  detectedAt: Date;
}

interface LegalInference {
  id: string;
  caseId: string;
  inference: string;
  legalPrinciple: string;
  supportingEvidence: string;
  caselaw: string;
  strength: string;
  category: string;
  generatedAt: Date;
}

interface CaseLike {
  caseType: string | null;
}

export class GapDetectionService {
  /**
   * Main entry point: Analyze a case for evidence gaps
   */
  async analyzeCase(caseId: string): Promise<GapAnalysisResult> {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Get case details
    const caseData = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    if (caseData.length === 0) throw new Error("Case not found");
    const caseInfo = caseData[0];

    // Build timeline from multiple sources
    const timelineEvents = await this.buildTimeline(caseId);

    // Detect communication gaps
    const gaps = await this.detectCommunicationGaps(caseId, timelineEvents);

    // Identify expected documents based on case type
    const expectedDocs = await this.identifyExpectedDocuments(caseId, caseInfo, timelineEvents);

    // Detect suspicious patterns
    const patterns = await this.detectSuspiciousPatterns(caseId, timelineEvents, gaps, expectedDocs);

    // Generate legal inferences
    const inferences = await this.generateLegalInferences(caseId, gaps, expectedDocs, patterns);

    // Calculate case strength
    const caseStrength = await this.calculateCaseStrength(
      caseId,
      timelineEvents,
      gaps,
      expectedDocs,
      patterns,
      inferences
    );

    // Save all results to database
    await this.saveResults(caseId, gaps, expectedDocs, patterns, inferences, caseStrength);

    return {
      gaps,
      expectedDocs,
      patterns,
      inferences,
      caseStrength,
    };
  }

  /**
   * Build unified timeline from communications and timeline events
   */
  private async buildTimeline(caseId: string): Promise<TimelineEvent[]> {
    const db = await getDb();
    if (!db) return [];

    const [comms, timelineData, evidenceData, evidenceFileData, caseRows] = await Promise.all([
      db.select().from(communications).where(eq(communications.caseId, caseId)).orderBy(asc(communications.createdAt)),
      db.select().from(timeline).where(eq(timeline.caseId, caseId)).orderBy(asc(timeline.eventAt)),
      db.select().from(evidence).where(eq(evidence.caseId, caseId)).orderBy(asc(evidence.createdAt)),
      db.select().from(evidenceFiles).where(eq(evidenceFiles.caseId, caseId)).orderBy(asc(evidenceFiles.uploadedAt)),
      db.select({ userId: cases.userId }).from(cases).where(eq(cases.id, caseId)).limit(1),
    ]);

    // Build the set of the case owner's connected email addresses so we can
    // infer whether a pulled email was sent (outbound) or received (inbound).
    const connectedEmails = new Set<string>();
    const caseRow = caseRows[0];
    if (caseRow?.userId) {
      const accounts = await db
        .select({ email: emailAccounts.email })
        .from(emailAccounts)
        .where(eq(emailAccounts.userId, caseRow.userId));
      for (const a of accounts) {
        if (a.email) connectedEmails.add(a.email.toLowerCase());
      }
    }

    // Pull an email address out of a "Name <addr@x.com>" style header value.
    const extractEmail = (raw: unknown): string =>
      (String(raw ?? "").match(/[^<\s]+@[^>\s]+/)?.[0] || "").toLowerCase();

    const events: TimelineEvent[] = [];

    // Add communications to timeline
    comms.forEach((comm) => {
      let commMeta: any = {};
      try {
        commMeta = comm.metadata ? JSON.parse(comm.metadata) : {};
      } catch {
        commMeta = {};
      }

      events.push({
        id: comm.id,
        date: comm.createdAt ?? new Date(),
        type: comm.channel || "communication",
        title: commMeta.subject || `${comm.channel || "message"} communication`,
        description: comm.body || undefined,
        direction: commMeta.direction as "inbound" | "outbound" | undefined,
        hasDocumentation: true,
        participants: Array.isArray(commMeta.participants) ? commMeta.participants : [],
      });
    });

    // Add timeline events
    timelineData.forEach((item) => {
      let timelineMeta: any = {};
      try {
        timelineMeta = item.metadata ? JSON.parse(item.metadata) : {};
      } catch {
        timelineMeta = {};
      }

      events.push({
        id: item.id,
        date: item.eventAt ?? item.createdAt ?? new Date(),
        type: item.eventType || "event",
        title: item.title || timelineMeta.event || "Timeline event",
        description: item.description || undefined,
        hasDocumentation: item.metadata ? true : false,
      });
    });

    // Add evidence items to timeline — these ARE documented events.
    // For pulled emails, recover the real sent date and direction from metadata
    // so communication-gap and unanswered-email detection actually work.
    evidenceData.forEach((item) => {
      let meta: any = {};
      try {
        meta = item.metadata ? JSON.parse(item.metadata) : {};
      } catch {
        meta = {};
      }

      const isEmail = (item.type || "").toLowerCase() === "email";
      const emailDate = isEmail && meta.date ? new Date(meta.date) : null;
      const date =
        emailDate && !isNaN(emailDate.getTime()) ? emailDate : item.createdAt ?? new Date();

      let direction: "inbound" | "outbound" | undefined;
      const fromAddr = extractEmail(meta.from);
      if (isEmail && fromAddr) {
        direction = connectedEmails.has(fromAddr) ? "outbound" : "inbound";
      }

      events.push({
        id: item.id,
        date,
        type: item.type || "document",
        title: item.title || item.fileName || "Evidence document",
        description: item.description || undefined,
        direction,
        hasDocumentation: true, // Evidence items are by definition documented
        participants: fromAddr ? [fromAddr] : [],
      });
    });

    // Add scanned files to timeline
    evidenceFileData.forEach((item) => {
      events.push({
        id: item.id,
        date: item.uploadedAt ?? new Date(),
        type: item.fileType || "document",
        title: item.fileName || "Scanned document",
        description: `Uploaded via ${item.uploadSource === "agent" ? "desktop scanner" : "manual upload"}`,
        hasDocumentation: true,
        participants: [],
      });
    });

    // Sort by date
    return events.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  /**
   * Detect communication gaps (no response, sudden silence, etc.)
   */
  private async detectCommunicationGaps(
    caseId: string,
    timelineEvents: TimelineEvent[]
  ): Promise<CommunicationGap[]> {
    const gaps: CommunicationGap[] = [];

    // Find periods of silence (7+ days between events)
    for (let i = 0; i < timelineEvents.length - 1; i++) {
      const current = timelineEvents[i];
      const next = timelineEvents[i + 1];

      const daysBetween =
        (next.date.getTime() - current.date.getTime()) / (1000 * 60 * 60 * 24);

      if (daysBetween >= 7 && this.isCriticalEvent(current)) {
        const significance =
          daysBetween >= 30 ? "critical" : daysBetween >= 14 ? "important" : "notable";

        gaps.push({
          id: nanoid(),
          caseId,
          gapType: "sudden_silence",
          startDate: current.date,
          endDate: next.date,
          durationDays: Math.round(daysBetween).toString(),
          context: `No communication for ${Math.round(daysBetween)} days after: ${current.title}`,
          significance,
          precedingEvents: JSON.stringify([current.id]),
          legalImplications: JSON.stringify(this.analyzeLegalImplications(current, daysBetween)),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    // Find unanswered communications
    const outgoing = timelineEvents.filter(
      (e) => e.type === "email" && e.direction === "outbound"
    );

    for (const sent of outgoing) {
      // Look for response within 7 days
      const response = timelineEvents.find(
        (e) =>
          e.type === "email" &&
          e.direction === "inbound" &&
          e.date > sent.date &&
          e.date.getTime() - sent.date.getTime() < 7 * 24 * 60 * 60 * 1000
      );

      if (!response) {
        const daysSince = (new Date().getTime() - sent.date.getTime()) / (1000 * 60 * 60 * 24);
        const significance = daysSince >= 30 ? "critical" : "important";

        gaps.push({
          id: nanoid(),
          caseId,
          gapType: "no_response",
          startDate: sent.date,
          endDate: null,
          durationDays: Math.round(daysSince).toString(),
          context: `No response to: ${sent.title}`,
          significance,
          precedingEvents: JSON.stringify([sent.id]),
          legalImplications: JSON.stringify([
            "Verify delivery, the expected response date, and whether a reply exists outside LARO",
            "No response by itself does not establish motive, liability, or bad faith",
            "Ask a qualified lawyer whether the silence has legal relevance in this case",
          ]),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    return gaps;
  }

  /**
   * Identify documents that should exist based on case type and Dutch law
   */
  private async identifyExpectedDocuments(
    caseId: string,
    caseInfo: CaseLike,
    timelineEvents: TimelineEvent[]
  ): Promise<ExpectedDocument[]> {
    const expectedDocs: ExpectedDocument[] = [];

    // For employment termination cases
    const caseType = (caseInfo.caseType || "").toLowerCase();
    if (caseType.includes("employment") || caseType.includes("termination")) {
      const terminationEvent = timelineEvents.find((e) =>
        e.title.toLowerCase().includes("termination") || e.title.toLowerCase().includes("fired")
      );

      if (terminationEvent) {
        const terminationDate = terminationEvent.date;

        expectedDocs.push(
          {
            id: nanoid(),
            caseId,
            gapId: null,
            documentType: "termination_letter",
            reason: "Potentially relevant termination record; verify whether it should exist for this case",
            legalRequirement: false,
            legalBasis: null,
            deadline: null,
            status: this.checkDocumentStatus("termination", timelineEvents),
            receivedAt: null,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: nanoid(),
            caseId,
            gapId: null,
            documentType: "final_paycheck",
            reason: "Potentially relevant final-payment record; verify scope and timing",
            legalRequirement: false,
            legalBasis: null,
            deadline: null,
            status: this.checkDocumentStatus("paycheck", timelineEvents),
            receivedAt: null,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: nanoid(),
            caseId,
            gapId: null,
            documentType: "vacation_days_payout",
            reason: "Potentially relevant leave-balance or payout record; verify applicability",
            legalRequirement: false,
            legalBasis: null,
            deadline: null,
            status: this.checkDocumentStatus("vacation", timelineEvents),
            receivedAt: null,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: nanoid(),
            caseId,
            gapId: null,
            documentType: "uwv_form",
            reason: "Potentially relevant unemployment-benefit record; verify applicability",
            legalRequirement: false,
            legalBasis: null,
            deadline: null,
            status: this.checkDocumentStatus("uwv", timelineEvents),
            receivedAt: null,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        );
      }
    }

    return expectedDocs;
  }

  /**
   * Detect suspicious patterns (documented→verbal shift, sudden exclusion, etc.)
   */
  private async detectSuspiciousPatterns(
    caseId: string,
    timelineEvents: TimelineEvent[],
    gaps: CommunicationGap[],
    expectedDocs: ExpectedDocument[]
  ): Promise<SuspiciousPattern[]> {
    const patterns: SuspiciousPattern[] = [];

    if (gaps.length === 0) return patterns;

    const firstGapDate = gaps[0].startDate;

    // Pattern 1: Documented to verbal shift
    const documentedPeriod = timelineEvents.filter(
      (e) => e.date < firstGapDate && e.hasDocumentation
    );
    const verbalPeriod = timelineEvents.filter(
      (e) => e.date >= firstGapDate && !e.hasDocumentation
    );

    if (documentedPeriod.length > 5 && verbalPeriod.length > 2) {
      patterns.push({
        id: nanoid(),
        caseId,
        patternType: "documented_to_verbal_shift",
        description:
          "The available record changes from documented to undocumented events after a communication gap",
        evidenceIds: JSON.stringify([
          ...documentedPeriod.slice(-3).map((e) => e.id),
          ...verbalPeriod.map((e) => e.id),
        ]),
        legalSignificance:
          "Review the missing context and verify whether records exist elsewhere; this pattern does not establish motive or wrongdoing.",
        confidence: "70",
        detectedAt: new Date(),
      });
    }

    const missing = expectedDocs.filter((document) => document.status === "missing" || document.status === "delayed");
    if (missing.length > 0) {
      patterns.push({
        id: nanoid(),
        caseId,
        patternType: "missing_expected_documents",
        description: `${missing.length} potentially relevant record(s) were not found in LARO`,
        evidenceIds: JSON.stringify(missing.map((document) => document.id)),
        legalSignificance: "Verify whether each record should exist, whether it is stored elsewhere, and whether its absence matters legally.",
        confidence: "80",
        detectedAt: new Date(),
      });
    }

    return patterns;
  }

  /**
   * Generate legal inferences from gaps and patterns
   */
  private async generateLegalInferences(
    caseId: string,
    gaps: CommunicationGap[],
    expectedDocs: ExpectedDocument[],
    patterns: SuspiciousPattern[]
  ): Promise<LegalInference[]> {
    const inferences: LegalInference[] = [];

    // Inference 1: Adverse inference from documented→verbal shift
    const verbalShiftPattern = patterns.find((p) => p.patternType === "documented_to_verbal_shift");
    if (verbalShiftPattern) {
      inferences.push({
        id: nanoid(),
        caseId,
        inference:
          "The communication channel changed in the available record; the reason for that change is not established.",
        legalPrinciple: "Evidence-review question only; no legal conclusion is drawn.",
        supportingEvidence: JSON.stringify([
          verbalShiftPattern.description,
          "Check calendars, call notes, other mailboxes, and records held by the other party.",
        ]),
        caselaw: JSON.stringify([]),
        strength: "review_required",
        category: "communication_channel_change",
        generatedAt: new Date(),
      });
    }

    const missingExpectedDocs = expectedDocs.filter(
      (document) => document.status === "missing" || document.status === "delayed"
    );
    if (missingExpectedDocs.length > 0) {
      inferences.push({
        id: nanoid(),
        caseId,
        inference:
          "Potentially relevant records were not found in LARO; this does not prove that they do not exist or were withheld.",
        legalPrinciple: "Verify existence, custody, applicability, and legal significance with a qualified lawyer.",
        supportingEvidence: JSON.stringify(
          missingExpectedDocs.map((document) => `${document.documentType} - ${document.reason}`)
        ),
        caselaw: JSON.stringify([]),
        strength: "review_required",
        category: "records_gap",
        generatedAt: new Date(),
      });
    }

    // Inference 3: Bad faith from prolonged non-response
    const criticalGaps = gaps.filter((g) => g.significance === "critical");
    if (criticalGaps.length > 0) {
      const longestGap = criticalGaps.reduce((prev, current) =>
        parseInt(current.durationDays || "0") > parseInt(prev.durationDays || "0")
          ? current
          : prev
      );

      inferences.push({
        id: nanoid(),
        caseId,
        inference: `${longestGap.durationDays} days without a recorded response requires context; it does not establish motive or wrongdoing.`,
        legalPrinciple: "Verify delivery, response expectations, external communications, and applicable duties.",
        supportingEvidence: JSON.stringify([
          `No response for ${longestGap.durationDays} days`,
          longestGap.context || "",
        ]),
        caselaw: JSON.stringify([]),
        strength: "review_required",
        category: "no_response_review",
        generatedAt: new Date(),
      });
    }

    return inferences;
  }

  /**
   * Calculate overall case strength based on evidence and gaps
   */
  private async calculateCaseStrength(
    caseId: string,
    timelineEvents: TimelineEvent[],
    gaps: CommunicationGap[],
    expectedDocs: ExpectedDocument[],
    patterns: SuspiciousPattern[],
    inferences: LegalInference[]
  ): Promise<any> {
    // Direct evidence score (based on documented events)
    const documentedEvents = timelineEvents.filter((e) => e.hasDocumentation);
    const directEvidenceScore = Math.min(100, (documentedEvents.length / 10) * 100);

    // Deterministic review questions cannot establish legal merit. This score is
    // intentionally zero until a source-verified legal analysis is available.
    const legalBasisScore = 0;

    // Gaps only reduce completeness. They never increase legal merit or confidence.
    const gapAnalysisImpact = Math.min(100,
      gaps.filter((g) => g.significance === "critical").length * 20 +
      gaps.filter((g) => g.significance === "important").length * 10 +
      expectedDocs.filter((d) => d.status === "missing").length * 15 +
      patterns.length * 10);
    const contextCoverageScore = timelineEvents.length > 0
      ? Math.max(0, 100 - gapAnalysisImpact)
      : 0;
    const overallScore = Math.min(100,
      directEvidenceScore * 0.7 + contextCoverageScore * 0.3);

    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const recommendations: string[] = [];

    if (directEvidenceScore > 70) {
      strengths.push("Strong direct evidence from documented communications");
    } else {
      weaknesses.push("Limited direct evidence");
      recommendations.push("Collect more documented evidence (emails, contracts, etc.)");
    }

    if (gapAnalysisImpact > 40) {
      weaknesses.push("Material gaps remain in the evidence available to LARO");
      recommendations.push("Verify whether the expected records exist elsewhere and document each search step");
    }

    if (gaps.some((g) => g.significance === "critical" && parseInt(g.durationDays || "0") > 30)) {
      weaknesses.push("A prolonged period has no recorded response or follow-up context");
      recommendations.push("Verify delivery and response expectations before drawing any conclusion from the silence");
    }

    const narrative = this.generateNarrative(
      timelineEvents,
      gaps,
      patterns,
      inferences,
      overallScore
    );

    return {
      overallScore: Math.round(overallScore),
      directEvidenceScore: Math.round(directEvidenceScore),
      // Kept for API/database compatibility; this now represents context coverage.
      circumstantialEvidenceScore: Math.round(contextCoverageScore),
      legalBasisScore: Math.round(legalBasisScore),
      gapAnalysisImpact: Math.round(gapAnalysisImpact),
      strengths,
      weaknesses,
      recommendations,
      narrative,
    };
  }

  /**
   * Generate narrative explanation of case strength
   */
  private generateNarrative(
    timelineEvents: TimelineEvent[],
    gaps: CommunicationGap[],
    patterns: SuspiciousPattern[],
    inferences: LegalInference[],
    overallScore: number
  ): string {
    const parts: string[] = [];

    parts.push(
      `The available evidence has a completeness score of ${Math.round(overallScore)}%. This is not a prediction of legal merit or outcome.`
    );

    if (timelineEvents.filter((e) => e.hasDocumentation).length > 5) {
      parts.push(
        `You have ${timelineEvents.filter((e) => e.hasDocumentation).length} documented events supporting your claims.`
      );
    }

    if (gaps.length > 0) {
      parts.push(
        `We identified ${gaps.length} communication gaps, including ${gaps.filter((g) => g.significance === "critical").length} high-priority gap(s) that require source verification.`
      );
    }

    if (patterns.some((p) => p.patternType === "documented_to_verbal_shift")) {
      parts.push(
        "The available record changes from documented to undocumented communication. LARO cannot determine why; check for records held elsewhere."
      );
    }

    if (inferences.some((i) => i.category === "records_gap")) {
      parts.push(
        "Potentially relevant records were not found in LARO. Their existence, custody, applicability, and legal significance remain unverified."
      );
    }

    return parts.join(" ");
  }

  /**
   * Save all analysis results to database
   */
  private async saveResults(
    caseId: string,
    gaps: CommunicationGap[],
    expectedDocs: ExpectedDocument[],
    patterns: SuspiciousPattern[],
    inferences: LegalInference[],
    caseStrength: any
  ): Promise<void> {
    const db = await getDb();
    if (!db) return;

    db.transaction((tx) => {
      tx.delete(communicationGaps).where(eq(communicationGaps.caseId, caseId)).run();
      tx.delete(expectedDocuments).where(eq(expectedDocuments.caseId, caseId)).run();
      tx.delete(suspiciousPatterns).where(eq(suspiciousPatterns.caseId, caseId)).run();
      tx.delete(legalInferences).where(eq(legalInferences.caseId, caseId)).run();
      tx.delete(caseStrengthAnalysis).where(eq(caseStrengthAnalysis.caseId, caseId)).run();

    // Save gaps into generic `data` column schema
    if (gaps.length > 0) {
      tx.insert(communicationGaps).values(
        gaps.map((g) => ({
          id: g.id,
          caseId: g.caseId,
          data: JSON.stringify({
            gapType: g.gapType,
            startDate: g.startDate,
            endDate: g.endDate,
            durationDays: g.durationDays,
            context: g.context,
            significance: g.significance,
            precedingEvents: g.precedingEvents,
            legalImplications: g.legalImplications,
            updatedAt: g.updatedAt,
          }),
          createdAt: g.createdAt,
        }))
      ).run();
    }

    // Save expected documents into generic `data` column schema
    if (expectedDocs.length > 0) {
      tx.insert(expectedDocuments).values(
        expectedDocs.map((d) => ({
          id: d.id,
          caseId: d.caseId,
          data: JSON.stringify({
            gapId: d.gapId,
            documentType: d.documentType,
            reason: d.reason,
            legalRequirement: d.legalRequirement,
            legalBasis: d.legalBasis,
            deadline: d.deadline,
            status: d.status,
            receivedAt: d.receivedAt,
            notes: d.notes,
            updatedAt: d.updatedAt,
          }),
          createdAt: d.createdAt,
        }))
      ).run();
    }

    // Save patterns into generic `data` column schema
    if (patterns.length > 0) {
      tx.insert(suspiciousPatterns).values(
        patterns.map((p) => ({
          id: p.id,
          caseId: p.caseId,
          data: JSON.stringify({
            patternType: p.patternType,
            description: p.description,
            evidenceIds: p.evidenceIds,
            legalSignificance: p.legalSignificance,
            confidence: p.confidence,
            detectedAt: p.detectedAt,
          }),
          createdAt: p.detectedAt,
        }))
      ).run();
    }

    // Save inferences into generic `data` column schema
    if (inferences.length > 0) {
      tx.insert(legalInferences).values(
        inferences.map((i) => ({
          id: i.id,
          caseId: i.caseId,
          data: JSON.stringify({
            inference: i.inference,
            legalPrinciple: i.legalPrinciple,
            supportingEvidence: i.supportingEvidence,
            caselaw: i.caselaw,
            strength: i.strength,
            category: i.category,
            generatedAt: i.generatedAt,
          }),
          createdAt: i.generatedAt,
        }))
      ).run();
    }

    // Save case strength analysis — store as numbers not strings
    tx.insert(caseStrengthAnalysis).values({
      id: nanoid(),
      caseId,
      data: JSON.stringify({
        overallScore: Number(caseStrength.overallScore),
        directEvidenceScore: Number(caseStrength.directEvidenceScore),
        circumstantialEvidenceScore: Number(caseStrength.circumstantialEvidenceScore),
        legalBasisScore: Number(caseStrength.legalBasisScore),
        gapAnalysisImpact: Number(caseStrength.gapAnalysisImpact),
        strengths: caseStrength.strengths,
        weaknesses: caseStrength.weaknesses,
        recommendations: caseStrength.recommendations,
        analysisNarrative: caseStrength.narrative,
        generatedAt: new Date(),
      }),
      createdAt: new Date(),
    }).run();
    });
  }

  /**
   * Helper: Check if event is critical (warrants follow-up)
   */
  private isCriticalEvent(event: TimelineEvent): boolean {
    const criticalKeywords = [
      "termination",
      "fired",
      "dismissed",
      "request",
      "demand",
      "complaint",
      "dispute",
      "violation",
    ];

    return criticalKeywords.some(
      (keyword) =>
        event.title.toLowerCase().includes(keyword) ||
        event.description?.toLowerCase().includes(keyword)
    );
  }

  /**
   * Helper: Analyze legal implications of a communication gap
   */
  private analyzeLegalImplications(event: TimelineEvent, daysSince: number): string[] {
    const implications: string[] = [];

    if (daysSince >= 30) {
      implications.push("Verify delivery, expected response timing, and communications outside LARO");
      implications.push("Prolonged silence alone does not establish motive, liability, or damages");
    }

    if (event.title.toLowerCase().includes("request")) {
      implications.push("Ask a qualified lawyer whether this unanswered request has legal significance");
    }

    if (event.title.toLowerCase().includes("termination")) {
      implications.push("Verify whether follow-up documentation should exist and whether it is stored elsewhere");
    }

    return implications;
  }

  /**
   * Helper: Check if a document type exists in timeline
   */
  private checkDocumentStatus(
    docType: string,
    timelineEvents: TimelineEvent[]
  ): "missing" | "delayed" | "incomplete" | "received" {
    const found = timelineEvents.some((e) => e.title.toLowerCase().includes(docType));
    return found ? "received" : "missing";
  }
}

export const gapDetectionService = new GapDetectionService();
