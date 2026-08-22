/**
 * KvK (Kamer van Koophandel - Dutch Chamber of Commerce) Integration Service
 * 
 * This service integrates with the KvK Open Dataset API to look up company information
 * for indirect evidence collection when opponents are uncooperative.
 * 
 * API Documentation: https://developers.kvk.nl/documentation/open-dataset-basis-bedrijfsgegevens-api
 * 
 * Features:
 * - Company lookup by KvK number
 * - Company search by name (via LinkedIn Data API fallback)
 * - Insolvency status check (bankruptcy, debt restructuring)
 * - Activity classification (SBI codes)
 * - Company status (active/inactive)
 */

import { readBoundedResponseJson, withBoundedHttpResponse } from "./boundedHttpResponse";

interface KvKCompanyData {
  datumAanvang: string; // Start date (YYYYMMDD format, may contain zeros for unknown parts)
  actief: "J" | "N"; // J = Yes (active), N = No (inactive)
  insolventieCode?: "FAIL" | "SSAN" | "SURS"; // FAIL = Bankruptcy, SSAN = Debt restructuring, SURS = Suspension of Payments
  rechtsvormCode: "BV" | "NV"; // BV = Private company, NV = Public limited company
  postcodeRegio: string | number; // First two digits of postal code
  activiteiten: Array<{
    sbiCode: string; // SBI activity code (up to 6 digits)
    soortActiviteit: "Hoofdactiviteit" | "Nevenactiviteit"; // Main or secondary activity
  }>;
  lidstaat: string; // Member state (always "NL" for Netherlands)
}

export interface KvKLookupResult {
  success: boolean;
  data?: {
    kvkNumber: string;
    startDate: string;
    isActive: boolean;
    insolvencyStatus?: {
      type: "bankruptcy" | "debt_restructuring" | "suspension_of_payments";
      code: string;
    };
    legalForm: "BV" | "NV";
    postalCodeRegion: string;
    activities: Array<{
      sbiCode: string;
      description?: string; // Will be enriched from SBI code lookup
      type: "main" | "secondary";
    }>;
  };
  error?: string;
  legalSignificance?: string; // How this data can be used as evidence
}

type KvKLookupData = NonNullable<KvKLookupResult["data"]>;

class KvKIntegrationService {
  private readonly BASE_URL = "https://opendata.kvk.nl/api/v1/hvds/basisbedrijfsgegevens";
  private readonly MAX_RESPONSE_BYTES = 1024 * 1024;
  private readonly REQUEST_TIMEOUT_MS = 15_000;
  private readonly RATE_LIMIT = 100; // 100 queries per 5 minutes
  private requestCount = 0;
  private resetTime = Date.now() + 5 * 60 * 1000;

  private fetchCompanyData(cleanKvK: string): Promise<KvKCompanyData> {
    return withBoundedHttpResponse(
      () => fetch(`${this.BASE_URL}/kvknummer/${cleanKvK}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS),
      }),
      async (response) => {
        if (response.status === 404) throw new Error("Company not found in KvK registry.");
        if (!response.ok) {
          throw new Error(`KvK API error: ${response.status} ${response.statusText}`);
        }
        return readBoundedResponseJson<KvKCompanyData>(response, {
          maxBytes: this.MAX_RESPONSE_BYTES,
          label: "KVK response",
        });
      },
    );
  }

  /**
   * Look up company information by KvK number
   */
  async lookupByKvKNumber(kvkNumber: string): Promise<KvKLookupResult> {
    try {
      // Check rate limit
      if (!this.checkRateLimit()) {
        return {
          success: false,
          error: "Rate limit exceeded. Please try again in a few minutes.",
        };
      }

      // Validate KvK number (must be 8 digits)
      const cleanKvK = kvkNumber.replace(/\D/g, "");
      if (cleanKvK.length !== 8) {
        return {
          success: false,
          error: "Invalid KvK number. Must be 8 digits.",
        };
      }

      const data = await this.fetchCompanyData(cleanKvK);

      // Parse insolvency status
      let insolvencyStatus: KvKLookupData["insolvencyStatus"];
      if (data.insolventieCode) {
        const typeMap = {
          FAIL: "bankruptcy" as const,
          SSAN: "debt_restructuring" as const,
          SURS: "suspension_of_payments" as const,
        };
        insolvencyStatus = {
          type: typeMap[data.insolventieCode],
          code: data.insolventieCode,
        };
      }

      // Parse activities
      const activities = data.activiteiten.map((act) => ({
        sbiCode: act.sbiCode,
        type: (act.soortActiviteit === "Hoofdactiviteit" ? "main" : "secondary") as
          | "main"
          | "secondary",
      }));

      // Determine legal significance
      const legalSignificance = this.determineLegalSignificance(data);

      return {
        success: true,
        data: {
          kvkNumber: cleanKvK,
          startDate: this.formatKvKDate(data.datumAanvang),
          isActive: data.actief === "J",
          insolvencyStatus,
          legalForm: data.rechtsvormCode,
          postalCodeRegion: String(data.postcodeRegio).padStart(2, "0"),
          activities,
        },
        legalSignificance,
      };
    } catch (error) {
      console.error("[KvK Integration] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Format KvK date (YYYYMMDD with possible zeros) to readable format
   */
  private formatKvKDate(kvkDate: string): string {
    if (!kvkDate || kvkDate === "00000000") {
      return "Unknown date";
    }

    const year = kvkDate.substring(0, 4);
    const month = kvkDate.substring(4, 6);
    const day = kvkDate.substring(6, 8);

    if (month === "00") {
      return `${year} (month unknown)`;
    }
    if (day === "00") {
      return `${year}-${month} (day unknown)`;
    }

    return `${year}-${month}-${day}`;
  }

  /**
   * Determine legal significance of KvK findings
   */
  private determineLegalSignificance(data: KvKCompanyData): string {
    const findings: string[] = [];

    // Insolvency status
    if (data.insolventieCode) {
      const statusMap = {
        FAIL: "Company is in bankruptcy - may affect ability to pay damages",
        SSAN: "Company is in debt restructuring - financial difficulties confirmed",
        SURS: "Company has suspension of payments - financial instability",
      };
      findings.push(statusMap[data.insolventieCode]);
    }

    // Inactive status
    if (data.actief === "N") {
      findings.push(
        "Company is no longer active - may complicate enforcement of judgment"
      );
    }

    // Recent establishment
    const startYear = parseInt(data.datumAanvang.substring(0, 4));
    const currentYear = new Date().getFullYear();
    if (currentYear - startYear < 2) {
      findings.push(
        "Company recently established - limited track record, potential shell company"
      );
    }

    if (findings.length === 0) {
      return "Company appears to be in good standing with no insolvency proceedings.";
    }

    return findings.join(". ");
  }

  /**
   * Check and update rate limit
   */
  private checkRateLimit(): boolean {
    const now = Date.now();

    // Reset counter if 5 minutes have passed
    if (now >= this.resetTime) {
      this.requestCount = 0;
      this.resetTime = now + 5 * 60 * 1000;
    }

    // Check if under limit
    if (this.requestCount >= this.RATE_LIMIT) {
      return false;
    }

    this.requestCount++;
    return true;
  }

  /**
   * Extract KvK numbers from text (case description, evidence, etc.)
   */
  extractKvKNumbers(text: string): string[] {
    // KvK numbers are 8 digits, often written as 12345678 or 12.34.56.78
    const patterns = [
      /\b\d{8}\b/g, // 12345678
      /\b\d{2}\.\d{2}\.\d{2}\.\d{2}\b/g, // 12.34.56.78
    ];

    const found: Set<string> = new Set();

    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach((match) => {
          const cleaned = match.replace(/\D/g, "");
          if (cleaned.length === 8) {
            found.add(cleaned);
          }
        });
      }
    }

    return Array.from(found);
  }
}

export const kvkIntegrationService = new KvKIntegrationService();

