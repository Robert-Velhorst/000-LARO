/**
 * Rechtspraak.nl Integration Service
 * 
 * This service integrates with the Dutch court records database (rechtspraak.nl)
 * to find precedent cases and opponent's litigation history.
 * 
 * API Documentation: https://www.rechtspraak.nl/Uitspraken/Paginas/Open-Data.aspx
 * 
 * Features:
 * - Search court decisions by company name, KvK number, or case type
 * - Retrieve ECLI (European Case Law Identifier) metadata
 * - Find precedent cases for legal arguments
 * - Discover opponent's litigation history
 * - Extract case outcomes and legal reasoning
 * 
 * Technical Details:
 * - Official Rechtspraak.nl RSS search with structured XML parsing
 * - Rate limit: 10 requests per second
 * - Free and public service
 */

import { load } from "cheerio";

interface ECLIMetadata {
  ecli: string; // European Case Law Identifier (e.g., ECLI:NL:RBAMS:2024:1234)
  instantie: string; // Court name
  zaaknummer?: string; // Case number
  datum: string; // Decision date (YYYY-MM-DD)
  rechtsgebied?: string; // Legal area (e.g., "Civiel recht", "Arbeidsrecht")
  proceduresoort?: string; // Procedure type
  inhoudsindicatie?: string; // Content summary
  vindplaatsen?: string[]; // Publication references
}

export interface CourtDecision {
  ecli: string;
  title: string;
  court: string;
  date: string;
  caseNumber?: string;
  legalArea?: string;
  summary?: string;
  fullText?: string;
  sourceUrl?: string;
  outcome?: "granted" | "denied" | "partial" | "unknown";
  relevanceScore?: number; // 0-100, how relevant to current case
}

export interface RechtspraakSearchResult {
  success: boolean;
  totalResults: number;
  decisions: CourtDecision[];
  error?: string;
  legalSignificance?: string;
  coverageNotice?: string;
}

const ECLI_PATTERN = /ECLI:NL:[A-Z0-9]+:\d{4}:[A-Z0-9.]+/i;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_RESULTS = 50;
const REQUEST_TIMEOUT_MS = 15_000;

function firstText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseDecisionTitle(title: string, ecli: string): {
  court: string;
  date: string;
  caseNumber?: string;
} {
  const remainder = title.slice(title.indexOf(ecli) + ecli.length).trim();
  const match = remainder.match(/^(.+?),\s*(\d{2})-(\d{2})-(\d{4})(?:,\s*(.+))?$/);
  if (!match) {
    return { court: "Unknown", date: "Unknown" };
  }

  return {
    court: match[1].trim(),
    date: `${match[4]}-${match[3]}-${match[2]}`,
    caseNumber: match[5]?.trim() || undefined,
  };
}

/** Parse the bounded RSS response without relying on cross-entry regular expressions. */
export function parseRechtspraakRss(xmlText: string, limit = MAX_RESULTS): CourtDecision[] {
  if (Buffer.byteLength(xmlText, "utf8") > MAX_FEED_BYTES) {
    throw new Error("Rechtspraak response exceeded the 5 MB safety limit");
  }

  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : MAX_RESULTS;
  const boundedLimit = Math.max(1, Math.min(requestedLimit, MAX_RESULTS));
  const $ = load(xmlText, { xml: true });
  const decisions: CourtDecision[] = [];
  const seen = new Set<string>();

  $("item").each((_, element) => {
    if (decisions.length >= boundedLimit) return false;

    const item = $(element);
    const title = firstText(item.children("title").first().text());
    const ecli = title.match(ECLI_PATTERN)?.[0]?.toUpperCase();
    if (!ecli || seen.has(ecli)) return;

    const sourceUrl = firstText(item.children("link").first().text());
    const summary = firstText(item.children("description").first().text());
    const parsedTitle = parseDecisionTitle(title, ecli);
    seen.add(ecli);
    decisions.push({
      ecli,
      title: title || ecli,
      court: parsedTitle.court,
      date: parsedTitle.date,
      caseNumber: parsedTitle.caseNumber,
      summary: summary || undefined,
      sourceUrl: /^https:\/\//i.test(sourceUrl) ? sourceUrl : undefined,
    });
  });

  return decisions;
}

export class RechtspraakIntegrationService {
  private readonly BASE_URL = "https://uitspraken.rechtspraak.nl/rss/";
  private readonly RATE_LIMIT_MS = 100; // 10 requests per second = 100ms between requests
  private lastRequestTime = 0;

  /**
   * Search for court decisions by company name
   */
  async searchByCompany(companyName: string, limit = 10): Promise<RechtspraakSearchResult> {
    try {
      await this.enforceRateLimit();

      const searchUrl = this.buildSearchUrl(companyName);

      const response = await fetch(searchUrl, {
        headers: {
          Accept: "application/rss+xml, application/xml;q=0.9",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Rechtspraak API error: ${response.status} ${response.statusText}`);
      }

      const xmlText = await response.text();
      const decisions = parseRechtspraakRss(xmlText, limit);

      return {
        success: true,
        totalResults: decisions.length,
        decisions: decisions.slice(0, limit),
        legalSignificance: this.determineLegalSignificance(companyName, decisions),
        coverageNotice: this.coverageNotice(),
      };
    } catch (error) {
      console.error("[Rechtspraak Integration] Error:", error);
      return {
        success: false,
        totalResults: 0,
        decisions: [],
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Search for precedent cases by legal issue
   */
  async searchPrecedents(
    legalIssue: string,
    legalArea: string = "Arbeidsrecht",
    limit = 5
  ): Promise<RechtspraakSearchResult> {
    try {
      await this.enforceRateLimit();

      const searchUrl = this.buildSearchUrl(legalIssue);

      const response = await fetch(searchUrl, {
        headers: {
          Accept: "application/rss+xml, application/xml;q=0.9",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Rechtspraak API error: ${response.status} ${response.statusText}`);
      }

      const xmlText = await response.text();
      const decisions = parseRechtspraakRss(xmlText, limit);

      // Calculate relevance scores
      const scoredDecisions = decisions.map((decision) => ({
        ...decision,
        relevanceScore: this.calculateRelevance(decision, legalIssue),
      }));

      // Sort by relevance
      scoredDecisions.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));

      return {
        success: true,
        totalResults: scoredDecisions.length,
        decisions: scoredDecisions.slice(0, limit),
        legalSignificance:
          `Returned ${scoredDecisions.length} recently published decisions matching "${legalIssue}". ` +
          "Relevance scores are lexical triage only; verify each source before relying on it.",
        coverageNotice:
          `${this.coverageNotice()} The requested legal area (${legalArea}) is context only; ` +
          "this search was filtered by the legal-issue text.",
      };
    } catch (error) {
      console.error("[Rechtspraak Integration] Error:", error);
      return {
        success: false,
        totalResults: 0,
        decisions: [],
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Get opponent's litigation history
   */
  async getOpponentHistory(companyName: string): Promise<{
    totalCases: number;
    wonCases: number;
    lostCases: number;
    recentCases: CourtDecision[];
    patterns: string[];
  }> {
    const searchResult = await this.searchByCompany(companyName, 50);

    if (!searchResult.success) {
      return {
        totalCases: 0,
        wonCases: 0,
        lostCases: 0,
        recentCases: [],
        patterns: [],
      };
    }

    // Analyze outcomes
    const wonCases = searchResult.decisions.filter((d) => d.outcome === "granted").length;
    const lostCases = searchResult.decisions.filter((d) => d.outcome === "denied").length;

    // Find patterns
    const patterns = this.identifyLitigationPatterns(searchResult.decisions);

    return {
      totalCases: searchResult.totalResults,
      wonCases,
      lostCases,
      recentCases: searchResult.decisions.slice(0, 5),
      patterns,
    };
  }

  private buildSearchUrl(searchTerm: string): string {
    const url = new URL(this.BASE_URL);
    url.searchParams.set("zoekterm", searchTerm.trim());
    url.searchParams.set("zoektermveld", "AlleVelden");
    return url.toString();
  }

  private coverageNotice(): string {
    return "Results come from the Rechtspraak.nl RSS search of published decisions and are not a complete litigation-history register.";
  }

  /**
   * Calculate relevance score for precedent case
   */
  private calculateRelevance(decision: CourtDecision, searchTerm: string): number {
    let score = 0;

    // Check if search term appears in title or summary
    const text = `${decision.title} ${decision.summary}`.toLowerCase();
    const term = searchTerm.toLowerCase();

    if (text.includes(term)) {
      score += 50;
    }

    // Bonus for recent cases (last 5 years)
    const decisionYear = parseInt(decision.date.split("-")[0]);
    const currentYear = new Date().getFullYear();
    if (currentYear - decisionYear <= 5) {
      score += 30;
    }

    // Bonus for higher courts
    if (decision.court.includes("Hoge Raad")) {
      score += 20;
    } else if (decision.court.includes("Gerechtshof")) {
      score += 10;
    }

    return Math.min(score, 100);
  }

  /**
   * Identify litigation patterns
   */
  private identifyLitigationPatterns(decisions: CourtDecision[]): string[] {
    const patterns: string[] = [];

    // Check for repeat litigation
    if (decisions.length >= 3) {
      patterns.push(
        `The query returned ${decisions.length} published decisions. Confirm that they concern the same legal entity before treating this as a pattern.`
      );
    }

    // Check for employment disputes
    const employmentCases = decisions.filter(
      (d) => d.legalArea === "Arbeidsrecht" || d.title.toLowerCase().includes("ontslag")
    );
    if (employmentCases.length >= 2) {
      patterns.push(
        `${employmentCases.length} results mention employment-related disputes; review the linked decisions before drawing conclusions.`
      );
    }

    return patterns;
  }

  /**
   * Determine legal significance of findings
   */
  private determineLegalSignificance(companyName: string, decisions: CourtDecision[]): string {
    if (decisions.length === 0) {
      return `No matching published decisions were returned for ${companyName}. This does not prove that no litigation exists.`;
    }

    return (
      `Returned ${decisions.length} recently published decisions matching "${companyName}". ` +
      "Verify party identity and read the linked sources before drawing conclusions."
    );
  }

  /**
   * Enforce rate limit (10 requests per second)
   */
  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.RATE_LIMIT_MS) {
      const waitTime = this.RATE_LIMIT_MS - timeSinceLastRequest;
      await new Promise((resolve) => {
        setTimeout(resolve, waitTime);
      });
    }

    this.lastRequestTime = Date.now();
  }
}

export const rechtspraakIntegrationService = new RechtspraakIntegrationService();

