import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { pool } from "../db/index.js";
import { config } from "../config.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";

const router = Router();

// ── Webhook (no auth — verified by signature) ─────────────────────────────

function verifyLsSignature(rawBody: Buffer, signature: string): boolean {
  if (!config.lemonSqueezyWebhookSecret) return false;
  const expected = createHmac("sha256", config.lemonSqueezyWebhookSecret)
    .update(rawBody)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function variantIdToPlan(variantId: string): "pro" | "power" | null {
  if (variantId === config.lemonSqueezyProVariantId) return "pro";
  if (variantId === config.lemonSqueezyPowerVariantId) return "power";
  return null;
}

router.post(
  "/webhook",
  // Use raw body for signature verification
  (req: Request, res: Response, next) => {
    let rawBody = Buffer.alloc(0);
    req.on("data", (chunk: Buffer) => { rawBody = Buffer.concat([rawBody, chunk]); });
    req.on("end", () => {
      (req as Request & { rawBody: Buffer }).rawBody = rawBody;
      next();
    });
  },
  async (req: Request & { rawBody?: Buffer }, res: Response): Promise<void> => {
    const signature = req.headers["x-signature"] as string | undefined;
    if (!signature || !req.rawBody) {
      res.status(400).json({ error: "Missing signature or body" });
      return;
    }

    if (!verifyLsSignature(req.rawBody, signature)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }

    const eventName = payload.meta && typeof payload.meta === "object"
      ? (payload.meta as Record<string, unknown>).event_name as string | undefined
      : undefined;
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = data?.attributes as Record<string, unknown> | undefined;

    if (!eventName || !data || !attributes) {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    // Extract tenant from custom data
    const customData = attributes.custom_data as Record<string, unknown> | undefined;
    const tenantId = customData?.tenant_id as string | undefined;
    if (!tenantId) {
      res.status(200).json({ ok: true, skipped: "no tenant_id in custom_data" });
      return;
    }

    const lsSubscriptionId = String(data.id ?? "");
    const lsCustomerId = String(attributes.customer_id ?? "");
    const lsVariantId = String(attributes.variant_id ?? "");
    const currentPeriodEnd = attributes.renews_at
      ? new Date(attributes.renews_at as string)
      : null;

    try {
      switch (eventName) {
        case "subscription_created":
        case "subscription_updated": {
          const plan = variantIdToPlan(lsVariantId) ?? "free";
          await pool.query(
            `INSERT INTO subscriptions (tenant_id, plan, ls_customer_id, ls_subscription_id, ls_variant_id, status, current_period_end, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'active', $6, NOW())
             ON CONFLICT (tenant_id) DO UPDATE
               SET plan = $2,
                   ls_customer_id = $3,
                   ls_subscription_id = $4,
                   ls_variant_id = $5,
                   status = 'active',
                   cancel_at_period_end = FALSE,
                   current_period_end = $6,
                   updated_at = NOW()`,
            [tenantId, plan, lsCustomerId, lsSubscriptionId, lsVariantId, currentPeriodEnd]
          );
          break;
        }

        case "subscription_cancelled": {
          await pool.query(
            `UPDATE subscriptions
             SET cancel_at_period_end = TRUE, updated_at = NOW()
             WHERE tenant_id = $1`,
            [tenantId]
          );
          break;
        }

        case "subscription_expired":
        case "subscription_payment_failed": {
          await pool.query(
            `UPDATE subscriptions
             SET plan = 'free', status = 'expired', updated_at = NOW()
             WHERE tenant_id = $1`,
            [tenantId]
          );
          break;
        }

        case "subscription_resumed": {
          const plan = variantIdToPlan(lsVariantId) ?? "pro";
          await pool.query(
            `UPDATE subscriptions
             SET plan = $2, status = 'active', cancel_at_period_end = FALSE, updated_at = NOW()
             WHERE tenant_id = $1`,
            [tenantId, plan]
          );
          break;
        }
      }

      res.status(200).json({ ok: true });
    } catch (error) {
      console.error("[billing] webhook db error", error);
      res.status(500).json({ error: "Internal error" });
    }
  }
);

// ── Authenticated routes ───────────────────────────────────────────────────

router.use(authMiddleware);

// GET /api/billing/status — current plan + monthly usage
router.get("/status", async (req: AuthRequest, res: Response): Promise<void> => {
  const auth = req.authContext;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const subResult = await pool.query<{
      plan: string;
      status: string;
      cancel_at_period_end: boolean;
      current_period_end: string | null;
    }>(
      `SELECT plan, status, cancel_at_period_end, current_period_end
       FROM subscriptions WHERE tenant_id = $1`,
      [auth.tenantId]
    );

    const sub = subResult.rows[0] ?? { plan: "free", status: "active", cancel_at_period_end: false, current_period_end: null };

    const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const usageResult = await pool.query<{ action: string; cnt: number }>(
      `SELECT action, COUNT(*)::int AS cnt
       FROM memory_events
       WHERE tenant_id = $1 AND action IN ('save', 'recall') AND created_at >= $2
       GROUP BY action`,
      [auth.tenantId, periodStart]
    );

    const savesUsed = usageResult.rows.find((r) => r.action === "save")?.cnt ?? 0;
    const recallsUsed = usageResult.rows.find((r) => r.action === "recall")?.cnt ?? 0;

    res.json({
      plan: sub.plan,
      status: sub.status,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      currentPeriodEnd: sub.current_period_end,
      usage: {
        savesUsed,
        savesLimit: sub.plan === "free" ? 50 : null,
        recallsUsed,
        recallsLimit: sub.plan === "free" ? 200 : null,
      },
    });
  } catch (error) {
    console.error("[billing] status error", error);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/billing/checkout?plan=pro|power — redirect to LemonSqueezy checkout
router.get("/checkout", (req: AuthRequest, res: Response): void => {
  const auth = req.authContext;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const plan = req.query.plan as string | undefined;
  const variantId =
    plan === "power"
      ? config.lemonSqueezyPowerVariantId
      : config.lemonSqueezyProVariantId;

  if (!variantId) {
    res.status(503).json({ error: "Billing not configured" });
    return;
  }

  // LemonSqueezy hosted checkout URL
  // custom_data fields are passed through to webhooks
  const checkoutUrl = new URL(`https://tallei.lemonsqueezy.com/buy/${variantId}`);
  checkoutUrl.searchParams.set("checkout[custom][tenant_id]", auth.tenantId);
  checkoutUrl.searchParams.set("checkout[custom][user_id]", auth.userId);

  res.redirect(302, checkoutUrl.toString());
});

// GET /api/billing/portal — redirect to LemonSqueezy customer portal
router.get("/portal", async (req: AuthRequest, res: Response): Promise<void> => {
  const auth = req.authContext;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const result = await pool.query<{ ls_customer_id: string }>(
      `SELECT ls_customer_id FROM subscriptions WHERE tenant_id = $1`,
      [auth.tenantId]
    );

    const customerId = result.rows[0]?.ls_customer_id;
    if (!customerId) {
      res.status(404).json({ error: "No active subscription found" });
      return;
    }

    // Fetch a portal URL from LemonSqueezy API
    const lsRes = await fetch(
      `https://api.lemonsqueezy.com/v1/customers/${customerId}/portal`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.lemonSqueezyApiKey}`,
          Accept: "application/vnd.api+json",
        },
      }
    );

    if (!lsRes.ok) {
      res.status(502).json({ error: "Failed to fetch portal URL" });
      return;
    }

    const lsData = await lsRes.json() as { data?: { attributes?: { url?: string } } };
    const portalUrl = lsData?.data?.attributes?.url;
    if (!portalUrl) {
      res.status(502).json({ error: "No portal URL returned" });
      return;
    }

    res.redirect(302, portalUrl);
  } catch (error) {
    console.error("[billing] portal error", error);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
