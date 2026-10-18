import { z } from 'zod';

/**
 * Legal Areas Validator
 * Ensures legalAreas field is always stored as valid JSON
 */

// Define valid legal areas
export const VALID_LEGAL_AREAS = [
  'Corporate Law',
  'Employment Law',
  'Intellectual Property',
  'Real Estate',
  'Family Law',
  'Criminal Law',
  'Tax Law',
  'Immigration Law',
  'Contract Law',
  'Litigation',
  'Bankruptcy',
  'Administrative Law',
  'Environmental Law',
  'Healthcare Law',
  'Labor Law',
  'Mergers & Acquisitions',
  'Securities Law',
  'Trusts & Estates',
  'Other',
] as const;

export type LegalArea = (typeof VALID_LEGAL_AREAS)[number];

// Zod schema for validation
export const legalAreasSchema = z.array(
  z.enum(VALID_LEGAL_AREAS)
).min(1, 'At least one legal area is required').max(10, 'Maximum 10 legal areas allowed');

export type ValidatedLegalAreas = z.infer<typeof legalAreasSchema>;

/**
 * Validate and normalize legalAreas field
 * Accepts string (JSON), array, or single string value
 */
export function validateAndNormalizeLegalAreas(
  input: unknown
): { valid: true; data: string } | { valid: false; error: string } {
  try {
    let parsed: unknown;

    // Handle different input types
    if (typeof input === 'string') {
      // Try to parse as JSON first
      try {
        parsed = JSON.parse(input);
      } catch {
        // If not valid JSON, treat as single area
        parsed = [input];
      }
    } else if (Array.isArray(input)) {
      parsed = input;
    } else if (input === null || input === undefined) {
      return { valid: false, error: 'legalAreas cannot be empty' };
    } else {
      return { valid: false, error: 'legalAreas must be a string or array' };
    }

    // Validate against schema
    const validated = legalAreasSchema.parse(parsed);

    // Return as JSON string
    return { valid: true, data: JSON.stringify(validated) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstError = error.issues?.[0];
      return { valid: false, error: firstError?.message || 'Invalid legal areas' };
    }
    return { valid: false, error: 'Failed to validate legal areas' };
  }
}

/**
 * Parse and return legalAreas as array
 * Safe parsing with fallback to empty array
 */
export function parseLegalAreas(value: string | null | undefined): LegalArea[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => VALID_LEGAL_AREAS.includes(item));
    }
    return [];
  } catch {
    // If parsing fails, return empty array
    return [];
  }
}

/**
 * Sanitize legalAreas field for storage
 * Ensures it's always valid JSON
 */
export function sanitizeLegalAreas(value: unknown): string {
  const result = validateAndNormalizeLegalAreas(value);
  if (result.valid) {
    return result.data;
  }
  // Return empty array as JSON if validation fails
  return JSON.stringify([]);
}
