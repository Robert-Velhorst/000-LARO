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
  datumAanvang?: unknown; // Start date (YYYYMMDD format, may contain zeros for unknown parts)
  actief?: unknown; // J = Yes (active), N = No (inactive)
  insolventieCode?: unknown; // FAIL = Bankruptcy, SSAN = Debt restructuring, SURS = Suspension of Payments
  rechtsvormCode?: unknown; // BV = Private company, NV = Public limited company
  postcodeRegio?: unknown; // First two digits of postal code
  activiteiten?: unknown;
  lidstaat?: unknown; // Member state (normally "NL" for Netherlands)
}

export interface KvKFieldProvenance {
  sourceField: string;
  rawValue: string | null;
}

export interface KvKSourceProvenance {
  provider: "Kamer van Koophandel (KvK)";
  dataset: "Business Register Open Dataset - Basic Company Information";
  recordUrl: string;
  documentationUrl: string;
  retrievedAt: string;
}

export interface KvKReviewTriage {
  id: "inactive_registration";
  label: string;
  description: string;
  reviewOnly: true;
  sourceFields: string[];
}

export interface KvKLookupResult {
  success: boolean;
  data?: {
    kvkNumber: string;
    startDate: string | null;
    isActive: boolean | null;
    insolvencyStatus?: {
      type: "bankruptcy" | "debt_restructuring" | "suspension_of_payments";
      code: string;
      label: string;
    };
    legalForm: "BV" | "NV" | null;
    postalCodeRegion: string | null;
    activities: Array<{
      sbiCode: string;
      type: "main" | "secondary";
      sourceField: string;
    }>;
    fieldProvenance: {
      startDate: KvKFieldProvenance;
      activityStatus: KvKFieldProvenance;
      insolvencyStatus: KvKFieldProvenance;
      legalForm: KvKFieldProvenance;
      postalCodeRegion: KvKFieldProvenance;
    };
  };
  error?: string;
  source?: KvKSourceProvenance;
  limitations?: string[];
  reviewTriage?: KvKReviewTriage[];
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
    let source: KvKSourceProvenance | undefined;
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

      source = this.buildSourceProvenance(cleanKvK);

      const data = await this.fetchCompanyData(cleanKvK);

      // Parse insolvency status
      let insolvencyStatus: KvKLookupData["insolvencyStatus"];
      const insolvencyCode = this.stringValue(data.insolventieCode);
      if (insolvencyCode === "FAIL" || insolvencyCode === "SSAN" || insolvencyCode === "SURS") {
        const typeMap = {
          FAIL: "bankruptcy" as const,
          SSAN: "debt_restructuring" as const,
          SURS: "suspension_of_payments" as const,
        };
        const labelMap = {
          FAIL: "Bankruptcy (Faillissement)",
          SSAN: "Debt restructuring (Schuldsanering)",
          SURS: "Suspension of payments (Surseance van betaling)",
        };
        insolvencyStatus = {
          type: typeMap[insolvencyCode],
          code: insolvencyCode,
          label: labelMap[insolvencyCode],
        };
      }

      // Parse activities
      const activities = Array.isArray(data.activiteiten)
        ? data.activiteiten.flatMap((value, index) => {
            if (!value || typeof value !== "object") return [];
            const activity = value as Record<string, unknown>;
            const sbiCode = this.stringValue(activity.sbiCode);
            const activityType = this.stringValue(activity.soortActiviteit);
            if (!sbiCode || (activityType !== "Hoofdactiviteit" && activityType !== "Nevenactiviteit")) return [];
            return [{
              sbiCode,
              type: activityType === "Hoofdactiviteit" ? "main" as const : "secondary" as const,
              sourceField: `activiteiten[${index}]`,
            }];
          })
        : [];
      const startDateRaw = this.stringValue(data.datumAanvang);
      const activeRaw = this.stringValue(data.actief);
      const legalFormRaw = this.stringValue(data.rechtsvormCode);
      const postalCodeRaw = this.stringValue(data.postcodeRegio);
      const legalForm = legalFormRaw === "BV" || legalFormRaw === "NV" ? legalFormRaw : null;
      const postalCodeRegion = postalCodeRaw && /^\d{1,2}$/.test(postalCodeRaw)
        ? postalCodeRaw.padStart(2, "0")
        : null;
      const missingFields = [
        !startDateRaw ? "datumAanvang" : null,
        activeRaw !== "J" && activeRaw !== "N" ? "actief" : null,
        !legalForm ? "rechtsvormCode" : null,
        !postalCodeRegion ? "postcodeRegio" : null,
        !Array.isArray(data.activiteiten) ? "activiteiten" : null,
      ].filter((field): field is string => Boolean(field));
      const limitations = [
        "This open dataset contains selected basic registry fields only; it is not a complete legal or financial due-diligence report.",
        ...(!insolvencyStatus
          ? ["No insolventieCode was returned in this response. This does not verify good standing or prove that no insolvency proceeding exists."]
          : []),
        ...(missingFields.length
          ? [`The source did not return usable values for: ${missingFields.join(", ")}.`]
          : []),
      ];
      const reviewTriage: KvKReviewTriage[] = activeRaw === "N" ? [{
        id: "inactive_registration",
        label: "Review the current entity status",
        description: "The registry returned actief=N. Confirm the current entity and any relevant procedural details in an authoritative record before acting.",
        reviewOnly: true,
        sourceFields: ["actief"],
      }] : [];

      return {
        success: true,
        data: {
          kvkNumber: cleanKvK,
          startDate: this.formatKvKDate(startDateRaw),
          isActive: activeRaw === "J" ? true : activeRaw === "N" ? false : null,
          insolvencyStatus,
          legalForm,
          postalCodeRegion,
          activities,
          fieldProvenance: {
            startDate: { sourceField: "datumAanvang", rawValue: startDateRaw },
            activityStatus: { sourceField: "actief", rawValue: activeRaw },
            insolvencyStatus: { sourceField: "insolventieCode", rawValue: insolvencyCode },
            legalForm: { sourceField: "rechtsvormCode", rawValue: legalFormRaw },
            postalCodeRegion: { sourceField: "postcodeRegio", rawValue: postalCodeRaw },
          },
        },
        source,
        limitations,
        reviewTriage,
      };
    } catch (error) {
      console.error("[KvK Integration] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
        source,
      };
    }
  }

  /**
   * Format KvK date (YYYYMMDD with possible zeros) to readable format
   */
  private formatKvKDate(kvkDate: string | null): string | null {
    if (!kvkDate || kvkDate === "00000000") {
      return null;
    }

    if (!/^\d{8}$/.test(kvkDate)) return null;

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

  private stringValue(value: unknown): string | null {
    if (typeof value === "string") return value.trim() || null;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
  }

  private buildSourceProvenance(kvkNumber: string): KvKSourceProvenance {
    return {
      provider: "Kamer van Koophandel (KvK)",
      dataset: "Business Register Open Dataset - Basic Company Information",
      recordUrl: `${this.BASE_URL}/kvknummer/${kvkNumber}`,
      documentationUrl: "https://developers.kvk.nl/documentation/open-dataset-basis-bedrijfsgegevens-api",
      retrievedAt: new Date().toISOString(),
    };
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
