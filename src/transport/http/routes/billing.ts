import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { pool } from "../../../infrastructure/db/index.js";
import { config } from "../../../config/index.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.middleware.js";

const router = Router();

// ── Webhook (no auth — verified by signature) ─────────────────────────────

function verifyLsSignature(rawBody: Buffer, signature: string): boolean {
  if (!config.lemonSqueezyWebhookSecret) return false;
  const normalizedSignature = signature.trim().replace(/^sha256=/i, "").toLowerCase();
  const expected = createHmac("sha256", config.lemonSqueezyWebhookSecret)
    .update(rawBody)
    .digest("hex");
  if (normalizedSignature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(normalizedSignature, "hex"));
  } catch {
    return false;
  }
}

function variantIdToPlan(variantId: string): "pro" | "power" | null {
  if (variantId === config.lemonSqueezyProVariantId) return "pro";
  if (variantId === config.lemonSqueezyPowerVariantId) return "power";
  return null;
}

function lemonHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.lemonSqueezyApiKey}`,
    Accept: "application/vnd.api+json",
    "Content-Type": "application/vnd.api+json",
  };
}

function looksLikeSignedLsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.searchParams.has("signature") && parsed.searchParams.has("expires");
  } catch {
    return false;
  }
}

type SubscriptionRecord = {
  plan: string;
  status: string;
  cancel_at_period_end: boolean;
  ls_customer_id: string | null;
  ls_subscription_id: string | null;
};

async function getTenantSubscription(tenantId: string): Promise<SubscriptionRecord | null> {
  const result = await pool.query<SubscriptionRecord>(
    `SELECT plan, status, cancel_at_period_end, ls_customer_id, ls_subscription_id
     FROM subscriptions
     WHERE tenant_id = $1`,
    [tenantId]
  );
  return result.rows[0] ?? null;
}

function mapLsStatusToDbStatus(lsStatus: string | undefined): string {
  switch (lsStatus) {
    case "on_trial":
      return "trialing";
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "past_due":
    case "unpaid":
      return "payment_failed";
    case "cancelled":
    case "expired":
      return "expired";
    default:
      return "active";
  }
}

function canUpgradeInPlace(subscription: SubscriptionRecord | null): subscription is SubscriptionRecord {
  if (!subscription?.ls_subscription_id) return false;
  if (subscription.plan === "free") return false;
  return subscription.status === "active" || subscription.status === "trialing";
}

type LsSubscriptionUrls = {
  customerId: string | null;
  portalUrl: string | null;
  updatePaymentMethodUrl: string | null;
};

async function fetchSubscriptionUrls(subscriptionId: string): Promise<LsSubscriptionUrls | null> {
  const res = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`, {
    method: "GET",
    headers: lemonHeaders(),
  });
  if (!res.ok) return null;

  const subData = await res.json() as {
    data?: {
      attributes?: {
        customer_id?: number | string;
        urls?: {
          customer_portal?: string | null;
          update_payment_method?: string | null;
        };
      };
    };
  };

  const customerIdRaw = subData.data?.attributes?.customer_id;
  return {
    customerId: customerIdRaw === undefined || customerIdRaw === null ? null : String(customerIdRaw),
    portalUrl: subData.data?.attributes?.urls?.customer_portal ?? null,
    updatePaymentMethodUrl: subData.data?.attributes?.urls?.update_payment_method ?? null,
  };
}

async function fetchCustomerPortalUrl(customerId: string): Promise<string | null> {
  const customerRes = await fetch(`https://api.lemonsqueezy.com/v1/customers/${customerId}`, {
    method: "GET",
    headers: lemonHeaders(),
  });
  if (!customerRes.ok) return null;

  const customerData = await customerRes.json() as {
    data?: {
      attributes?: {
        urls?: {
          customer_portal?: string | null;
        };
      };
    };
  };
  return customerData.data?.attributes?.urls?.customer_portal ?? null;
}

router.post(
  "/webhook",
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

    // LemonSqueezy sends custom_data inside meta, not attributes
    const meta = payload.meta as Record<string, unknown>;
    const customData = (meta.custom_data ?? attributes.custom_data) as Record<string, unknown> | undefined;
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
          const lsStatus = attributes.status as string | undefined;
          const dbStatus = mapLsStatusToDbStatus(lsStatus);
          const dbPlan = dbStatus === "expired" ? "free" : plan;
          const trialEndsAt = attributes.trial_ends_at
            ? new Date(attributes.trial_ends_at as string)
            : null;
          await pool.query(
            `INSERT INTO subscriptions (tenant_id, plan, ls_customer_id, ls_subscription_id, ls_variant_id, status, current_period_end, trial_ends_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $7, $6, $8, NOW())
             ON CONFLICT (tenant_id) DO UPDATE
               SET plan = $2,
                   ls_customer_id = $3,
                   ls_subscription_id = $4,
                   ls_variant_id = $5,
                   status = $7,
                   cancel_at_period_end = FALSE,
                   current_period_end = $6,
                   trial_ends_at = $8,
                   updated_at = NOW()`,
            [tenantId, dbPlan, lsCustomerId, lsSubscriptionId, lsVariantId, currentPeriodEnd, dbStatus, trialEndsAt]
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
    const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const [subResult, usageResult] = await Promise.all([
      pool.query<{
        plan: string;
        status: string;
        cancel_at_period_end: boolean;
        current_period_end: string | null;
      }>(
        `SELECT plan, status, cancel_at_period_end, current_period_end
         FROM subscriptions WHERE tenant_id = $1`,
        [auth.tenantId]
      ),
      pool.query<{ saves_used: number; recalls_used: number }>(
        `SELECT
           COUNT(*) FILTER (WHERE action = 'save')::int AS saves_used,
           COUNT(*) FILTER (WHERE action = 'recall')::int AS recalls_used
         FROM memory_events
         WHERE tenant_id = $1
           AND action IN ('save', 'recall')
           AND created_at >= $2`,
        [auth.tenantId, periodStart]
      ),
    ]);

    const sub = subResult.rows[0] ?? {
      plan: "free",
      status: "active",
      cancel_at_period_end: false,
      current_period_end: null,
    };
    const usage = usageResult.rows[0] ?? { saves_used: 0, recalls_used: 0 };

    res.json({
      plan: sub.plan,
      status: sub.status,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      currentPeriodEnd: sub.current_period_end,
      usage: {
        savesUsed: usage.saves_used ?? 0,
        savesLimit: sub.plan === "free" ? 50 : null,
        recallsUsed: usage.recalls_used ?? 0,
        recallsLimit: sub.plan === "free" ? 200 : null,
      },
    });
  } catch (error) {
    console.error("[billing] status error", error);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/billing/checkout?plan=pro|power — redirect to LemonSqueezy checkout
// If user already has an active subscription, upgrades in-place (proration handled by LS).
router.get("/checkout", async (req: AuthRequest, res: Response): Promise<void> => {
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

  try {
    const checkoutReturnUrl = new URL("/dashboard/billing", config.dashboardBaseUrl);
    checkoutReturnUrl.searchParams.set("checkout", "success");
    checkoutReturnUrl.searchParams.set("plan", plan === "power" ? "power" : "pro");

    // If user has an active subscription, upgrade in-place instead of creating a new checkout.
    const existing = await getTenantSubscription(auth.tenantId);
    if (canUpgradeInPlace(existing)) {
      const upgradeRes = await fetch(
        `https://api.lemonsqueezy.com/v1/subscriptions/${existing.ls_subscription_id}`,
        {
          method: "PATCH",
          headers: lemonHeaders(),
          body: JSON.stringify({
            data: {
              type: "subscriptions",
              id: existing.ls_subscription_id,
              attributes: {
                variant_id: parseInt(variantId, 10),
                // Charge the prorated difference immediately
                invoice_immediately: true,
              },
            },
          }),
        }
      );

      if (!upgradeRes.ok) {
        console.error("[billing] Failed to upgrade subscription:", await upgradeRes.text());
        res.status(502).json({ error: "Failed to upgrade subscription" });
        return;
      }

      res.redirect(302, checkoutReturnUrl.toString());
      return;
    }

    // No existing subscription — create a new checkout.

    // 1. First fetch the variant to get the correct store_id
    const variantRes = await fetch(`https://api.lemonsqueezy.com/v1/variants/${variantId}`, {
      headers: lemonHeaders(),
    });

    if (!variantRes.ok) {
      console.error("[billing] Failed to fetch variant:", await variantRes.text());
      res.status(502).json({ error: "Failed to fetch billing variant" });
      return;
    }

    const variantData = (await variantRes.json()) as {
      data?: { relationships?: { product?: { links?: { related?: string } } } };
    };

    // We need to fetch the product to get the store ID, since the variant itself only links to product
    const productUrl = variantData.data?.relationships?.product?.links?.related;
    if (!productUrl) {
      res.status(502).json({ error: "Invalid variant relationships" });
      return;
    }

    const productRes = await fetch(productUrl, {
      headers: lemonHeaders(),
    });

    if (!productRes.ok) {
      console.error("[billing] Failed to fetch product:", await productRes.text());
      res.status(502).json({ error: "Failed to fetch billing product" });
      return;
    }

    const productData = (await productRes.json()) as {
      data?: { attributes?: { store_id?: number } };
    };

    const storeId = productData.data?.attributes?.store_id?.toString();
    if (!storeId) {
      res.status(502).json({ error: "Could not determine store ID" });
      return;
    }

    // 2. Generate a checkout URL securely via the LemonSqueezy API
    // This correctly handles store domains, test mode, and custom data bindings
    const lsRes = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: lemonHeaders(),
      body: JSON.stringify({
        data: {
          type: "checkouts",
          attributes: {
            product_options: {
              redirect_url: checkoutReturnUrl.toString(),
              receipt_button_text: "Return to Tallei",
              receipt_link_url: checkoutReturnUrl.toString(),
            },
            checkout_data: {
              custom: {
                tenant_id: auth.tenantId,
                user_id: auth.userId,
              },
            },
          },
          relationships: {
            store: {
              data: {
                type: "stores",
                id: storeId,
              },
            },
            variant: {
              data: {
                type: "variants",
                id: variantId,
              },
            },
          },
        },
      }),
    });

    if (!lsRes.ok) {
      console.error("[billing] Failed to create checkout URL:", await lsRes.text());
      res.status(502).json({ error: "Failed to generate checkout URL" });
      return;
    }

    const lsData = (await lsRes.json()) as { data?: { attributes?: { url?: string } } };
    const checkoutUrl = lsData?.data?.attributes?.url;

    if (!checkoutUrl) {
      res.status(502).json({ error: "No checkout URL returned from provider" });
      return;
    }

    res.redirect(302, checkoutUrl);
  } catch (error) {
    console.error("[billing] checkout error", error);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/billing/portal — redirect to LemonSqueezy customer portal
router.get("/portal", async (req: AuthRequest, res: Response): Promise<void> => {
  const auth = req.authContext;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const subscription = await getTenantSubscription(auth.tenantId);
    let customerId = subscription?.ls_customer_id ?? null;
    const subscriptionId = subscription?.ls_subscription_id ?? null;
    let portalUrl: string | null = null;

    if (subscriptionId) {
      const urls = await fetchSubscriptionUrls(subscriptionId);
      if (urls) {
        portalUrl = urls.portalUrl;
        if (urls.customerId && urls.customerId !== customerId) {
          customerId = urls.customerId;
          await pool.query(
            `UPDATE subscriptions
             SET ls_customer_id = $2, updated_at = NOW()
             WHERE tenant_id = $1`,
            [auth.tenantId, customerId]
          );
        }
      }
    }

    if ((!portalUrl || !looksLikeSignedLsUrl(portalUrl)) && customerId) {
      const customerPortalUrl = await fetchCustomerPortalUrl(customerId);
      if (customerPortalUrl && looksLikeSignedLsUrl(customerPortalUrl)) {
        portalUrl = customerPortalUrl;
      }
    }

    if (portalUrl && looksLikeSignedLsUrl(portalUrl)) {
      res.redirect(302, portalUrl);
      return;
    }

    if (!customerId) {
      res.status(404).json({ error: "No active subscription found" });
      return;
    }
    res.status(502).json({ error: "Failed to fetch signed customer portal URL" });
  } catch (error) {
    console.error("[billing] portal error", error);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/billing/payment-method — redirect to signed payment method URL
router.get("/payment-method", async (req: AuthRequest, res: Response): Promise<void> => {
  const auth = req.authContext;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const subscription = await getTenantSubscription(auth.tenantId);
    const subscriptionId = subscription?.ls_subscription_id ?? null;

    if (!subscriptionId) {
      res.status(404).json({ error: "No active subscription found" });
      return;
    }

    const urls = await fetchSubscriptionUrls(subscriptionId);
    const updatePaymentUrl = urls?.updatePaymentMethodUrl ?? null;

    if (!updatePaymentUrl || !looksLikeSignedLsUrl(updatePaymentUrl)) {
      res.status(502).json({ error: "Failed to fetch signed payment method URL" });
      return;
    }

    res.redirect(302, updatePaymentUrl);
  } catch (error) {
    console.error("[billing] payment-method error", error);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/billing/invoices — list subscription invoices from LemonSqueezy
router.get("/invoices", async (req: AuthRequest, res: Response): Promise<void> => {
  const auth = req.authContext;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const subscription = await getTenantSubscription(auth.tenantId);
    const subscriptionId = subscription?.ls_subscription_id;

    if (!subscriptionId) {
      res.json({ invoices: [] });
      return;
    }

    const lsRes = await fetch(
      `https://api.lemonsqueezy.com/v1/subscription-invoices?filter[subscription_id]=${subscriptionId}&sort=-createdAt&page[size]=25`,
      { headers: lemonHeaders() }
    );

    if (!lsRes.ok) {
      console.error("[billing] Failed to fetch invoices:", await lsRes.text());
      res.status(502).json({ error: "Failed to fetch invoices" });
      return;
    }

    const data = await lsRes.json() as {
      data?: Array<{
        id: string;
        attributes: {
          invoice_number?: number;
          status?: string;
          status_formatted?: string;
          total_formatted?: string;
          billing_reason?: string;
          card_brand?: string;
          card_last_four?: string;
          created_at?: string;
          refunded?: boolean;
          urls?: { invoice_url?: string | null; receipt_url?: string | null };
        };
      }>;
    };

    const invoices = (data.data ?? []).map((item) => ({
      id: item.id,
      invoiceNumber: item.attributes.invoice_number ?? null,
      status: item.attributes.status ?? "unknown",
      statusFormatted: item.attributes.status_formatted ?? item.attributes.status ?? "Unknown",
      total: item.attributes.total_formatted ?? "—",
      billingReason: item.attributes.billing_reason ?? null,
      cardBrand: item.attributes.card_brand ?? null,
      cardLastFour: item.attributes.card_last_four ?? null,
      createdAt: item.attributes.created_at ?? null,
      refunded: item.attributes.refunded ?? false,
      invoiceUrl: item.attributes.urls?.invoice_url ?? null,
      receiptUrl: item.attributes.urls?.receipt_url ?? null,
    }));

    res.json({ invoices });
  } catch (error) {
    console.error("[billing] invoices error", error);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/billing/cancel — cancel at period end
router.post("/cancel", async (req: AuthRequest, res: Response): Promise<void> => {
  const auth = req.authContext;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const subscription = await getTenantSubscription(auth.tenantId);
    const subscriptionId = subscription?.ls_subscription_id ?? null;
    if (!subscriptionId) {
      res.status(404).json({ error: "No active subscription found" });
      return;
    }

    const cancelRes = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`, {
      method: "DELETE",
      headers: lemonHeaders(),
    });

    if (!cancelRes.ok) {
      const details = await cancelRes.text();
      console.error("[billing] cancel failed:", details);
      res.status(502).json({ error: "Failed to cancel subscription" });
      return;
    }

    const cancelData = (await cancelRes.json()) as {
      data?: {
        attributes?: {
          status?: string;
          ends_at?: string | null;
          renews_at?: string | null;
        };
      };
    };

    const attrs = cancelData.data?.attributes;
    const currentPeriodEnd = attrs?.ends_at ?? attrs?.renews_at ?? null;
    const nextStatus = attrs?.status ?? "cancelled";

    await pool.query(
      `UPDATE subscriptions
       SET cancel_at_period_end = TRUE,
           status = $2,
           current_period_end = COALESCE($3::timestamptz, current_period_end),
           updated_at = NOW()
       WHERE tenant_id = $1`,
      [auth.tenantId, nextStatus, currentPeriodEnd]
    );

    res.json({
      ok: true,
      status: nextStatus,
      cancelAtPeriodEnd: true,
      currentPeriodEnd,
    });
  } catch (error) {
    console.error("[billing] cancel error", error);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/billing/resume — undo cancellation before expiry
router.post("/resume", async (req: AuthRequest, res: Response): Promise<void> => {
  const auth = req.authContext;
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const subscription = await getTenantSubscription(auth.tenantId);
    const subscriptionId = subscription?.ls_subscription_id ?? null;
    if (!subscriptionId) {
      res.status(404).json({ error: "No active subscription found" });
      return;
    }

    const resumeRes = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      headers: lemonHeaders(),
      body: JSON.stringify({
        data: {
          type: "subscriptions",
          id: subscriptionId,
          attributes: {
            cancelled: false,
          },
        },
      }),
    });

    if (!resumeRes.ok) {
      const details = await resumeRes.text();
      console.error("[billing] resume failed:", details);
      res.status(502).json({ error: "Failed to resume subscription" });
      return;
    }

    const resumeData = (await resumeRes.json()) as {
      data?: {
        attributes?: {
          status?: string;
          renews_at?: string | null;
        };
      };
    };

    const attrs = resumeData.data?.attributes;
    const currentPeriodEnd = attrs?.renews_at ?? null;
    const nextStatus = attrs?.status ?? "active";

    await pool.query(
      `UPDATE subscriptions
       SET cancel_at_period_end = FALSE,
           status = $2,
           current_period_end = COALESCE($3::timestamptz, current_period_end),
           updated_at = NOW()
       WHERE tenant_id = $1`,
      [auth.tenantId, nextStatus, currentPeriodEnd]
    );

    res.json({
      ok: true,
      status: nextStatus,
      cancelAtPeriodEnd: false,
      currentPeriodEnd,
    });
  } catch (error) {
    console.error("[billing] resume error", error);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
