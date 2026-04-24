import { Router } from "express";
import { pool } from "../../../infrastructure/db/index.js";
import {
  getIntegrationAsset,
  getPendingIntegrationAssets,
  INTEGRATION_ASSETS,
} from "../../shared/integration-assets.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

type AcknowledgementRow = {
  asset_key: string;
  acknowledged_version: string;
};

const router = Router();

router.use(authMiddleware);

async function getAcknowledgements(userId: string): Promise<Map<string, string>> {
  const result = await pool.query<AcknowledgementRow>(
    `SELECT asset_key, acknowledged_version
     FROM integration_asset_acknowledgements
     WHERE user_id = $1`,
    [userId]
  );

  return new Map(result.rows.map((row) => [row.asset_key, row.acknowledged_version]));
}

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const acknowledgements = await getAcknowledgements(userId);
    res.json({ updates: getPendingIntegrationAssets(acknowledgements) });
  } catch (error) {
    console.error("[integration-updates] failed to read updates:", error);
    res.status(500).json({ error: "Failed to load integration updates" });
  }
});

router.get("/assets", requireScopes(["memory:read"]), (_req: AuthRequest, res) => {
  res.json({ assets: INTEGRATION_ASSETS });
});

router.post("/:assetKey/acknowledge", requireScopes(["memory:write"]), async (req: AuthRequest, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const assetKey = Array.isArray(req.params.assetKey) ? req.params.assetKey[0] : req.params.assetKey;
  const asset = getIntegrationAsset(assetKey);
  if (!asset) {
    res.status(404).json({
      error: "Unknown integration asset",
      supportedAssets: INTEGRATION_ASSETS.map((item) => item.assetKey),
    });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO integration_asset_acknowledgements (user_id, asset_key, acknowledged_version, acknowledged_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, asset_key)
       DO UPDATE SET acknowledged_version = EXCLUDED.acknowledged_version,
                     acknowledged_at = EXCLUDED.acknowledged_at`,
      [userId, asset.assetKey, asset.latestVersion]
    );

    res.json({ acknowledged: asset });
  } catch (error) {
    console.error("[integration-updates] failed to acknowledge update:", error);
    res.status(500).json({ error: "Failed to acknowledge integration update" });
  }
});

export default router;
