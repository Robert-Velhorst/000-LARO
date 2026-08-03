import crypto from "crypto";

export const MIN_BOOTSTRAP_TOKEN_LENGTH = 32;
export const MAX_BOOTSTRAP_TOKEN_LENGTH = 256;

function safeTokenMatch(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  if (expectedBytes.length !== suppliedBytes.length) return false;
  return crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

export function standaloneSignupAllowed(options: {
  serverOnly: boolean;
  existingUserCount: number;
  expectedBootstrapToken?: string;
  suppliedBootstrapToken?: string;
}): boolean {
  if (!options.serverOnly) return true;
  if (options.existingUserCount !== 0) return false;

  const expected = options.expectedBootstrapToken?.trim() || "";
  const supplied = options.suppliedBootstrapToken?.trim() || "";
  if (
    expected.length < MIN_BOOTSTRAP_TOKEN_LENGTH ||
    expected.length > MAX_BOOTSTRAP_TOKEN_LENGTH ||
    !supplied
  ) return false;
  return safeTokenMatch(expected, supplied);
}
