import crypto from "crypto";
import { ENV } from "./_core/env";

export function hashPasswordResetCode(code: string): string {
  return crypto
    .createHmac("sha256", ENV.COOKIE_SECRET)
    .update(code)
    .digest("hex");
}
