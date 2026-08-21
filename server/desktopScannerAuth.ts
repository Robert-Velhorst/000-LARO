import { timingSafeEqual } from "crypto";
import type { Request } from "express";
import {
  DESKTOP_SCANNER_HEADER,
  MIN_DESKTOP_SCANNER_SECRET_LENGTH,
} from "../shared/desktopScannerAuth";

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isDesktopScannerRequest(req: Request): boolean {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const configured = process.env.LARO_DESKTOP_SCANNER_SECRET || "";
  const supplied = req.get(DESKTOP_SCANNER_HEADER) || "";
  if (
    configured.length < MIN_DESKTOP_SCANNER_SECRET_LENGTH ||
    supplied.length !== configured.length
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(supplied, "utf8"), Buffer.from(configured, "utf8"));
}
