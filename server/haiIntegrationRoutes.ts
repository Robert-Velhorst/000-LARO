import { Router } from "express";
import { createAuditLog } from "./audit";
import {
  authenticateHaiToken,
  buildHaiFeed,
  HAI_FEED_DEFAULT_LIMIT,
  HAI_FEED_PATH,
  HAI_HEALTH_PATH,
  HaiIntegrationError,
} from "./haiIntegration";

const router = Router();

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

function respondWithError(res: any, error: unknown) {
  const status = error instanceof HaiIntegrationError ? error.status : 500;
  if (status === 429) res.setHeader("Retry-After", "60");
  res.status(status).json({ error: status === 500 ? "HAI integration request failed" : (error as Error).message });
}

router.get(HAI_HEALTH_PATH, async (req, res) => {
  try {
    const auth = await authenticateHaiToken(bearerToken(req.headers.authorization));
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json({ status: "ready", scope: "hai:read", ownerBound: true, tokenPrefix: auth.tokenPrefix });
  } catch (error) {
    respondWithError(res, error);
  }
});

router.get(HAI_FEED_PATH, async (req, res) => {
  try {
    const auth = await authenticateHaiToken(bearerToken(req.headers.authorization));
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : HAI_FEED_DEFAULT_LIMIT;
    if (!Number.isFinite(rawLimit)) throw new HaiIntegrationError("Feed limit is invalid", 400);
    const result = await buildHaiFeed(
      auth.userId,
      typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      rawLimit,
    );
    await createAuditLog({
      userId: auth.userId,
      action: "integration.hai_feed_read",
      entityType: "integration_token",
      entityId: auth.tokenId,
      details: { itemCount: result.items.length, incremental: typeof req.query.cursor === "string" },
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json(result);
  } catch (error) {
    respondWithError(res, error);
  }
});

export default router;
