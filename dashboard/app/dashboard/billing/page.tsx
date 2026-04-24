"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CreditCard,
  ExternalLink,
  Receipt,
  RefreshCw,
  X,
  Zap,
} from "lucide-react";
import { useSession } from "next-auth/react";
import styles from "./page.module.css";

interface BillingStatus {
  plan: "free" | "pro" | "power";
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  usage: {
    savesUsed: number;
    savesLimit: number | null;
    recallsUsed: number;
    recallsLimit: number | null;
  };
}

interface Invoice {
  id: string;
  invoiceNumber: number | null;
  status: string;
  statusFormatted: string;
  total: string;
  billingReason: string | null;
  cardBrand: string | null;
  cardLastFour: string | null;
  createdAt: string | null;
  refunded: boolean;
  invoiceUrl: string | null;
  receiptUrl: string | null;
}

const PLAN_LABELS: Record<string, string> = { free: "Free", pro: "Pro", power: "Power" };

const PLAN_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  free: { bg: "#f8fafc", text: "#475569", border: "#e2e8f0" },
  pro: { bg: "#eefaf1", text: "#1f7a43", border: "#b8edc8" },
  power: { bg: "#faf5ff", text: "#6b21a8", border: "#e9d5ff" },
};

const PLAN_CARDS = [
  {
    key: "free" as const,
    name: "Free",
    price: "$0",
    period: "",
    description: "Get started with basic memory features",
    features: ["50 saves/month", "200 recalls/month", "All 3 AI platforms"],
  },
  {
    key: "pro" as const,
    name: "Pro",
    price: "$9",
    period: "/mo",
    description: "For developers building with AI memory",
    features: [
      "5,000 saves/month included",
      "100,000 recalls/month included",
      "All 3 AI platforms",
      "Link memories to PDFs",
    ],
    featured: true,
  },
  {
    key: "power" as const,
    name: "Power",
    price: "$19",
    period: "/mo",
    description: "For teams and production workloads",
    features: ["25,000 saves/month included", "500,000 recalls/month included", "API access + export", "Priority support"],
  },
];

function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden"));
}

function UsageBar({ used, limit, label }: { used: number; limit: number | null; label: string }) {
  if (limit === null) {
    return (
      <div className={styles.usageItem}>
        <div className={styles.usageLabelRow}>
          <span className={styles.usageLabel}>{label}</span>
          <span className={styles.usageHint}>High-volume included</span>
        </div>
        <div className={styles.usageTrack}>
          <div className={`${styles.usageFill} ${styles.usageFillIncluded}`} />
        </div>
      </div>
    );
  }

  const pct = Math.min(100, (used / limit) * 100);
  const isNearLimit = pct >= 80;

  return (
    <div className={styles.usageItem}>
      <div className={styles.usageLabelRow}>
        <span className={styles.usageLabel}>{label}</span>
        <span className={`${styles.usageHint} ${isNearLimit ? styles.usageDanger : ""}`}>
          {used} / {limit}
        </span>
      </div>
      <div className={styles.usageTrack}>
        <div
          className={`${styles.usageFill} ${isNearLimit ? styles.usageFillDanger : styles.usageFillPrimary}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function PlanCard({
  name,
  price,
  period,
  description,
  features,
  current,
  checkoutPlan,
  featured = false,
}: {
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  current: boolean;
  checkoutPlan: string;
  featured?: boolean;
}) {
  return (
    <article className={`${styles.planCard} ${featured ? styles.planCardFeatured : ""}`}>
      <div className={styles.planHead}>
        <span className={`${styles.planName} ${featured ? styles.planNameFeatured : ""}`}>{name}</span>
        {featured && <span className={styles.planBadge}>Most popular</span>}
        {current && <span className={styles.planBadgeCurrent}>Current</span>}
      </div>

      <div>
        <div className={styles.planPriceRow}>
          <span className={styles.planPrice}>{price}</span>
          {period ? <span className={styles.planPeriod}>{period}</span> : null}
        </div>
        <p className={styles.planDescription}>{description}</p>
      </div>

      <ul className={styles.planFeatures}>
        {features.map((f) => (
          <li key={f} className={styles.planFeatureItem}>
            <Check size={16} />
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div className={styles.planActions}>
        {!current ? (
          <a
            href={`/api/billing/checkout?plan=${checkoutPlan}`}
            className={`${styles.planButton} ${featured ? styles.planButtonFeatured : styles.planButtonDefault}`}
          >
            {featured ? `Get Tallei ${name}` : `Get Tallei ${name}`}
            <ChevronRight size={15} />
          </a>
        ) : (
          <div className={styles.planButtonCurrent}>Current Plan</div>
        )}
        {(featured || checkoutPlan === "power") && !current ? (
          <p className={styles.planTrial}>14-day free trial</p>
        ) : null}
      </div>
    </article>
  );
}

function AlertDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = false,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    getFocusable(dialogRef.current)[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const els = getFocusable(dialogRef.current);
      if (!els.length) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (!active || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!active || active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus();
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="billing-alert-title"
        aria-describedby="billing-alert-desc"
        ref={dialogRef}
        className={styles.alertDialog}
      >
        <h3 id="billing-alert-title" className={styles.alertTitle}>
          {title}
        </h3>
        <p id="billing-alert-desc" className={styles.alertDescription}>
          {description}
        </p>
        <div className={styles.alertActions}>
          <button onClick={onCancel} className={styles.alertCancelBtn}>
            {cancelLabel}
          </button>
          <button onClick={onConfirm} className={`${styles.alertConfirmBtn} ${danger ? styles.alertConfirmDanger : ""}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function InvoiceStatusBadge({ status, refunded }: { status: string; refunded: boolean }) {
  if (refunded) return <span className={`${styles.invoiceBadge} ${styles.invoiceBadgeRefunded}`}>Refunded</span>;
  if (status === "paid") return <span className={`${styles.invoiceBadge} ${styles.invoiceBadgePaid}`}>Paid</span>;
  if (status === "failed" || status === "payment_failed") {
    return <span className={`${styles.invoiceBadge} ${styles.invoiceBadgeFailed}`}>Failed</span>;
  }
  if (status === "pending") return <span className={`${styles.invoiceBadge} ${styles.invoiceBadgePending}`}>Pending</span>;
  if (status === "void") return <span className={`${styles.invoiceBadge} ${styles.invoiceBadgeVoid}`}>Void</span>;
  return <span className={`${styles.invoiceBadge} ${styles.invoiceBadgeVoid}`}>{status}</span>;
}

function InvoicesTab() {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/billing/invoices")
      .then((r) => r.json())
      .then((d: { invoices?: Invoice[]; error?: string }) => {
        if (d.error) throw new Error(d.error);
        setInvoices(d.invoices ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load invoices"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className={styles.invoiceSkeletonStack}>
        {[1, 2, 3].map((i) => (
          <div key={i} className={styles.invoiceSkeletonRow} />
        ))}
      </div>
    );
  }

  if (error) {
    return <div className={styles.errorInline}>{error}</div>;
  }

  if (!invoices || invoices.length === 0) {
    return (
      <div className={styles.emptyInvoices}>
        <Receipt size={32} />
        <p>No invoices yet</p>
      </div>
    );
  }

  const failed = invoices.filter((inv) => inv.status === "failed" || inv.status === "payment_failed");

  return (
    <div className={styles.invoiceWrap}>
      {failed.length > 0 ? (
        <div className={styles.failedBanner}>
          <AlertTriangle size={16} />
          <div>
            <div className={styles.failedBannerTitle}>
              {failed.length} payment{failed.length > 1 ? "s" : ""} failed
            </div>
            <p>Please update your payment details to keep your subscription active.</p>
          </div>
          <a href="/api/billing/payment-method" className={styles.failedBannerAction}>
            Update card <ChevronRight size={13} />
          </a>
        </div>
      ) : null}

      <div className={styles.invoiceTableWrap}>
        <table className={styles.invoiceTable}>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Date</th>
              <th>Amount</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv, i) => (
              <tr key={inv.id} className={i < invoices.length - 1 ? styles.invoiceRowBorder : ""}>
                <td>
                  {inv.invoiceNumber ? `#${inv.invoiceNumber}` : "—"}
                  {inv.billingReason ? (
                    <span className={styles.invoiceReason}>
                      {inv.billingReason === "initial"
                        ? "New subscription"
                        : inv.billingReason === "renewal"
                          ? "Renewal"
                          : inv.billingReason}
                    </span>
                  ) : null}
                </td>
                <td>
                  {inv.createdAt
                    ? new Date(inv.createdAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })
                    : "—"}
                </td>
                <td>
                  {inv.total}
                  {inv.cardLastFour ? <span className={styles.invoiceCardLast4}>·· {inv.cardLastFour}</span> : null}
                </td>
                <td>
                  <InvoiceStatusBadge status={inv.status} refunded={inv.refunded} />
                </td>
                <td className={styles.invoiceActionCell}>
                  {inv.receiptUrl || inv.invoiceUrl ? (
                    <a
                      href={inv.receiptUrl ?? inv.invoiceUrl ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.invoiceReceiptLink}
                    >
                      Receipt <ExternalLink size={12} />
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function BillingPage() {
  const { data: session, update } = useSession();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [billingAction, setBillingAction] = useState<"cancel" | "resume" | null>(null);
  const [isManageModalOpen, setIsManageModalOpen] = useState(false);
  const [showCancelAlert, setShowCancelAlert] = useState(false);
  const [activeTab, setActiveTab] = useState<"subscription" | "invoices">("subscription");
  const [invoicesLoaded, setInvoicesLoaded] = useState(false);
  const manageModalRef = useRef<HTMLDivElement | null>(null);
  const sessionPlanRef = useRef(session?.user?.plan);

  useEffect(() => {
    sessionPlanRef.current = session?.user?.plan;
  }, [session?.user?.plan]);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/status");
      if (!res.ok) throw new Error("Failed to load billing info");
      const data: BillingStatus = await res.json();
      setStatus(data);
      if (sessionPlanRef.current && data.plan !== sessionPlanRef.current) {
        await update({ forcePlanRefresh: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [update]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!isManageModalOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    getFocusable(manageModalRef.current)[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeManageModal();
        return;
      }
      if (e.key !== "Tab") return;
      const items = getFocusable(manageModalRef.current);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? manageModalRef.current?.contains(active) : false;
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
      prev?.focus();
    };
  }, [isManageModalOpen]);

  async function cancelSubscription() {
    setBillingAction("cancel");
    setError(null);
    try {
      const res = await fetch("/api/billing/cancel", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Failed to cancel subscription");
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel subscription");
    } finally {
      setBillingAction(null);
      setShowCancelAlert(false);
    }
  }

  async function resumeSubscription() {
    setBillingAction("resume");
    setError(null);
    try {
      const res = await fetch("/api/billing/resume", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Failed to resume subscription");
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume subscription");
    } finally {
      setBillingAction(null);
    }
  }

  const plan = status?.plan ?? "free";
  const planColor = PLAN_COLORS[plan] ?? PLAN_COLORS.free;
  const currentPlanLabel = PLAN_LABELS[plan] ?? "Plan";
  const closeManageModal = () => setIsManageModalOpen(false);

  const visibleCards = PLAN_CARDS.filter((p) => {
    if (plan === "free") return true;
    if (plan === "pro") return p.key !== "free";
    if (plan === "power") return p.key === "power";
    return true;
  });

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Billing</h1>
          <p className={styles.pageSubtitle}>Manage your plan and usage</p>
        </div>
        <div className={styles.headerRight}>
          <button className={styles.actionBtn} onClick={() => void fetchStatus()}>
            <RefreshCw size={16} className={loading ? styles.spin : ""} />
            Refresh
          </button>
        </div>
      </header>

      <div className={styles.tabs}>
        {(["subscription", "invoices"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => {
              setActiveTab(tab);
              if (tab === "invoices") setInvoicesLoaded(true);
            }}
            className={`${styles.tabBtn} ${activeTab === tab ? styles.tabBtnActive : ""}`}
          >
            {tab === "subscription" ? "Subscription" : "Invoices"}
          </button>
        ))}
      </div>

      {error ? <div className={styles.errorBanner}>{error}</div> : null}

      {activeTab === "subscription" ? (
        loading && !status ? (
          <div className={styles.skeletonStack}>
            <div className={styles.skeletonCardLarge} />
            <div className={styles.skeletonCardLarge} />
            <div className={styles.skeletonPlanGrid}>
              <div className={styles.skeletonPlanCard} />
              <div className={styles.skeletonPlanCard} />
            </div>
          </div>
        ) : (
          <div className={styles.subscriptionStack}>
            <section
              className={styles.planBanner}
              style={{ background: planColor.bg, borderColor: planColor.border }}
            >
              <div className={styles.planBannerLeft}>
                <div className={styles.planBannerIconWrap} style={{ borderColor: planColor.border }}>
                  <Zap size={18} style={{ color: planColor.text }} />
                </div>
                <div>
                  <div className={styles.planBannerTitle} style={{ color: planColor.text }}>
                    {PLAN_LABELS[plan]} Plan
                  </div>
                  {status?.cancelAtPeriodEnd && status.currentPeriodEnd ? (
                    <div className={styles.planBannerDanger}>
                      Cancels {new Date(status.currentPeriodEnd).toLocaleDateString()}
                    </div>
                  ) : status?.currentPeriodEnd ? (
                    <div className={styles.planBannerRenew} style={{ color: planColor.text }}>
                      Renews {new Date(status.currentPeriodEnd).toLocaleDateString()}
                    </div>
                  ) : null}
                </div>
              </div>

              {plan !== "free" ? (
                <button type="button" onClick={() => setIsManageModalOpen(true)} className={styles.manageBtn}>
                  Manage
                </button>
              ) : null}
            </section>

            <section className={styles.usageCard}>
              <h2 className={styles.sectionTitle}>This month&apos;s usage</h2>
              {status ? (
                <>
                  <UsageBar used={status.usage.savesUsed} limit={status.usage.savesLimit} label="Memory saves" />
                  <UsageBar used={status.usage.recallsUsed} limit={status.usage.recallsLimit} label="Memory recalls" />
                </>
              ) : null}
            </section>

            {plan !== "power" ? (
              <section>
                <h2 className={styles.sectionTitle}>{plan === "free" ? "Choose a plan" : "Available upgrade"}</h2>
                <div className={styles.planGrid}>
                  {visibleCards.map((planCard) => (
                    <PlanCard
                      key={planCard.key}
                      name={planCard.name}
                      price={planCard.price}
                      period={planCard.period}
                      description={planCard.description}
                      features={planCard.features}
                      current={planCard.key === plan}
                      checkoutPlan={planCard.key}
                      featured={"featured" in planCard ? planCard.featured : false}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            <p className={styles.planNote}>
              Plans are designed for high-volume daily use. Fair-use protections apply.
            </p>
          </div>
        )
      ) : invoicesLoaded ? (
        <InvoicesTab />
      ) : null}

      {isManageModalOpen && plan !== "free" ? (
        <div
          className={styles.overlay}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeManageModal();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="billing-manage-title"
            ref={manageModalRef}
            className={styles.manageModal}
          >
            <div className={styles.manageHeader}>
              <div>
                <h2 id="billing-manage-title" className={styles.manageTitle}>
                  Manage billing
                </h2>
                <p className={styles.manageSubtitle}>{currentPlanLabel} plan · payments secured by Lemon Squeezy</p>
              </div>
              <button type="button" onClick={closeManageModal} className={styles.iconCloseBtn} aria-label="Close">
                <X size={14} />
              </button>
            </div>

            <div className={styles.paymentCard}>
              <div className={styles.paymentCardLeft}>
                <CreditCard size={15} />
                <div>
                  <div className={styles.paymentTitle}>Payment details</div>
                  <p>Update your card and billing details.</p>
                </div>
              </div>
              <a href="/api/billing/payment-method" className={styles.paymentAction}>
                Update details <ExternalLink size={12} />
              </a>
            </div>

            <div className={styles.cancelCard}>
              <div className={styles.cancelHead}>
                <div className={styles.cancelTitle}>
                  {status?.cancelAtPeriodEnd ? "Cancellation scheduled" : "Cancel subscription"}
                </div>
                {!status?.cancelAtPeriodEnd ? <span className={styles.cancelTag}>takes effect at period end</span> : null}
              </div>
              <p className={styles.cancelDesc}>
                {status?.cancelAtPeriodEnd && status.currentPeriodEnd
                  ? `Your plan ends on ${new Date(status.currentPeriodEnd).toLocaleDateString()}.`
                  : "Access stays active until the end of your current billing period."}
              </p>

              {status?.cancelAtPeriodEnd ? (
                <button
                  onClick={() => void resumeSubscription()}
                  disabled={billingAction !== null}
                  className={styles.resumeBtn}
                >
                  {billingAction === "resume" ? "Resuming…" : "Resume subscription"}
                </button>
              ) : (
                <button
                  onClick={() => setShowCancelAlert(true)}
                  disabled={billingAction !== null}
                  className={styles.cancelBtn}
                >
                  Cancel subscription
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <AlertDialog
        open={showCancelAlert}
        title="Cancel subscription?"
        description={`Your ${currentPlanLabel} plan will remain active until the end of the current billing period, then your account will revert to the free tier.`}
        confirmLabel={billingAction === "cancel" ? "Cancelling…" : "Yes, cancel"}
        cancelLabel="Keep subscription"
        danger
        onConfirm={() => void cancelSubscription()}
        onCancel={() => setShowCancelAlert(false)}
      />
    </div>
  );
}
