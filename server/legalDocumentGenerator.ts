interface GapAnalysisData {
  caseId: string;
  clientName: string;
  opponentName: string;
  opponentAddress?: string;
  gaps: Array<{ type: string; description: string; durationDays?: number }>;
  missingDocuments: Array<{ type: string; legalRequirement?: string; deadline?: string }>;
  suspiciousPatterns: Array<{ pattern: string; evidence: string }>;
}

export interface GeneratedDocument {
  type: "discovery_request" | "preservation_notice" | "spoliation_warning" | "demand_letter";
  title: string;
  content: string;
  legalBasis: string[];
  deadline?: string;
  consequences?: string[];
}

const REVIEW_HEADER = "DRAFT FOR FACTUAL AND LEGAL REVIEW - DO NOT SEND WITHOUT REVIEW";

class LegalDocumentGeneratorService {
  generateDiscoveryRequest(data: GapAnalysisData): GeneratedDocument {
    const deadline = this.suggestedResponseDate(14);
    const records = this.numbered(
      data.missingDocuments.map((item) => item.type),
      "No specific missing records have been identified. Add the records sought before sending."
    );
    return this.document(
      "discovery_request",
      "Draft records request",
      data,
      `Subject: Request for records concerning case ${data.caseId}

Dear Sir/Madam,

On behalf of ${data.clientName}, I request copies of the records listed below that may be relevant to the matter between the parties:

${records}

Please respond by ${this.formatDate(deadline)}. This is a proposed response date and is not presented as a statutory or court-ordered deadline. If a requested record does not exist, is not held by you, or cannot be provided, please identify the item and explain that position. Please also state whether responsive records are held in another system or by another custodian.

This draft does not assert that ${data.clientName} has a legal entitlement to every listed record. Scope, legal basis, confidentiality, privilege, proportionality, and the correct procedure must be checked for the specific matter before sending.

Yours faithfully,
[Name]
For ${data.clientName}`,
      deadline,
      ["Verify the legal basis and procedure", "Narrow each requested record by date, subject, and custodian", "Remove privileged or irrelevant categories"]
    );
  }

  generatePreservationNotice(data: GapAnalysisData): GeneratedDocument {
    const records = this.numbered(
      data.missingDocuments.map((item) => item.type),
      "No specific record categories have been identified. Define a proportionate scope before sending."
    );
    return this.document(
      "preservation_notice",
      "Draft records preservation request",
      data,
      `Subject: Request to preserve potentially relevant records for case ${data.caseId}

Dear Sir/Madam,

On behalf of ${data.clientName}, I ask that reasonable steps be considered to preserve potentially relevant records while this matter is reviewed. The current workspace identifies these record categories:

${records}

Please confirm receipt and identify any material limitation affecting preservation, such as routine deletion, unavailable accounts, former custodians, or records held by another party.

This draft does not determine that a legal preservation duty exists, define its duration, or allege destruction or concealment. A qualified reviewer should verify the applicable duties, scope, custodians, systems, retention periods, and proportionality before sending.

Yours faithfully,
[Name]
For ${data.clientName}`,
      undefined,
      ["Verify whether a preservation duty applies", "Define relevant systems, dates, and custodians", "Avoid requesting unrelated personal or privileged material"]
    );
  }

  generateSpoliationWarning(data: GapAnalysisData): GeneratedDocument {
    const observations = this.numbered(
      data.suspiciousPatterns.map((item) => `${item.pattern}${item.evidence ? ` (workspace references: ${item.evidence})` : ""}`),
      "No record pattern is currently identified. Do not send this draft without adding verified facts."
    );
    return this.document(
      "spoliation_warning",
      "Draft missing-records clarification",
      data,
      `Subject: Clarification requested about records for case ${data.caseId}

Dear Sir/Madam,

The current case workspace contains the following record-availability questions:

${observations}

Please clarify whether the referenced records exist, where they are held, whether they remain accessible, and what searches have been performed. If records are unavailable, please explain when and why they became unavailable and identify any applicable retention process.

The observations above are generated from incomplete case data. Missing records or communication gaps do not by themselves show that records were destroyed or concealed, identify anyone's intent, establish liability, or determine any legal consequence. Those questions require source verification and legal review.

Yours faithfully,
[Name]
For ${data.clientName}`,
      undefined,
      ["Verify every observation against the source documents", "Ask for clarification without alleging misconduct", "Have a qualified reviewer assess any legal significance"]
    );
  }

  generateDemandLetter(data: GapAnalysisData, demandAmount?: number): GeneratedDocument {
    const deadline = this.suggestedResponseDate(14);
    const openItems = this.numbered(
      data.gaps.map((item) => `${item.description || item.type}${item.durationDays ? ` (${item.durationDays} days in the available record)` : ""}`),
      "No open item is currently identified. Add verified facts and the requested resolution before sending."
    );
    const payment = demandAmount
      ? `\nThe proposed resolution currently includes payment of EUR ${demandAmount.toLocaleString("nl-NL")}. Verify the amount, calculation, currency, payee, and legal basis before sending.\n`
      : "";
    return this.document(
      "demand_letter",
      "Draft request for resolution",
      data,
      `Subject: Proposed resolution of case ${data.caseId}

Dear Sir/Madam,

On behalf of ${data.clientName}, I request a response concerning the following open items recorded in the current case workspace:

${openItems}
${payment}
Please provide a substantive response by ${this.formatDate(deadline)}. This is a proposed response date, not a verified statutory or contractual deadline.

This draft does not establish breach, default, damages, interest, costs, or entitlement to a remedy. The facts, requested outcome, legal basis, required formalities, recipients, and deadline must be checked for the specific matter before sending.

Yours faithfully,
[Name]
For ${data.clientName}`,
      deadline,
      ["Verify the facts and requested remedy", "Check required notice formalities and the correct recipient", "Confirm any amount and deadline from primary sources"]
    );
  }

  private document(
    type: GeneratedDocument["type"],
    title: string,
    data: GapAnalysisData,
    body: string,
    deadline?: Date,
    reviewChecklist: string[] = []
  ): GeneratedDocument {
    return {
      type,
      title,
      content: `${REVIEW_HEADER}\n\nDate: ${this.formatDate(new Date())}\nTo: ${data.opponentName}\n${data.opponentAddress || "[Address to verify]"}\n\n${body}`,
      legalBasis: [],
      deadline: deadline ? this.formatDate(deadline) : undefined,
      consequences: reviewChecklist,
    };
  }

  private numbered(items: string[], emptyMessage: string): string {
    return items.length > 0 ? items.map((item, index) => `${index + 1}. ${item}`).join("\n") : emptyMessage;
  }

  private suggestedResponseDate(days: number): Date {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date;
  }

  private formatDate(date: Date): string {
    return [date.getDate(), date.getMonth() + 1, date.getFullYear()]
      .map((part, index) => index < 2 ? String(part).padStart(2, "0") : String(part))
      .join("-");
  }
}

export const legalDocumentGeneratorService = new LegalDocumentGeneratorService();
