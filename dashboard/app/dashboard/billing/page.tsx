"use client";
import { useEffect, useRef, useState } from "react";
import { Zap, Check, ArrowRight, RefreshCw, ExternalLink, X, CreditCard, AlertTriangle, Receipt, ChevronRight } from "lucide-react";

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
  free:  { bg: "#f8fafc", text: "#475569",  border: "#e2e8f0" },
  pro:   { bg: "#f0fdf4", text: "#166534",  border: "#bbf7d0" },
  power: { bg: "#faf5ff", text: "#6b21a8",  border: "#e9d5ff" },
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
    features: ["5,000 saves/month included", "100,000 recalls/month included", "All 3 AI platforms", "Link memories to PDFs"],
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
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 14, color: "var(--text-2)", fontWeight: 500 }}>{label}</span>
          <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 500 }}>High-volume included</span>
        </div>
        <div style={{ height: 6, background: "#f1f5f9", borderRadius: 999 }}>
          <div style={{ height: "100%", width: "100%", background: "#6366f1", borderRadius: 999, opacity: 0.15 }} />
        </div>
      </div>
    );
  }

  const pct = Math.min(100, (used / limit) * 100);
  const isNearLimit = pct >= 80;

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 14, color: "var(--text-2)", fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 13, color: isNearLimit ? "#dc2626" : "var(--text-muted)", fontWeight: 500 }}>
          {used} / {limit}
        </span>
      </div>
      <div style={{ height: 6, background: "#f1f5f9", borderRadius: 999, overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: isNearLimit ? "#dc2626" : "#6366f1",
            borderRadius: 999,
            transition: "width 0.4s ease",
          }}
        />
      </div>
    </div>
  );
}

function PlanCard({
  name, price, period, description, features, current, checkoutPlan, featured = false,
}: {
  name: string; price: string; period: string; description: string;
  features: string[]; current: boolean; checkoutPlan: string; featured?: boolean;
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: featured ? "2px solid #6366f1" : "1px solid #e2e8f0",
        borderRadius: 12,
        padding: 24,
        flex: 1,
        minWidth: 260,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: featured ? "#6366f1" : "#64748b" }}>
          {name}
        </span>
        {featured && (
          <span style={{ fontSize: 11, fontWeight: 600, color: "#6366f1", border: "1px solid #6366f1", background: "#f5f3ff", borderRadius: 999, padding: "2px 7px" }}>
            Most popular
          </span>
        )}
        {current && (
          <span style={{ fontSize: 11, fontWeight: 600, background: "#10b981", color: "#fff", borderRadius: 999, padding: "2px 7px" }}>
            Current
          </span>
        )}
      </div>

      <div>
        <div style={{ fontFamily: "DM Sans, sans-serif", fontWeight: 700, fontSize: 30, color: "#0f172a", lineHeight: 1.2 }}>
          {price}
          {period && <span style={{ fontSize: 15, fontWeight: 500, color: "#64748b", marginLeft: 2 }}>{period}</span>}
        </div>
        <p style={{ margin: "6px 0 0 0", fontSize: 14, color: "#64748b", lineHeight: 1.5 }}>{description}</p>
      </div>

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 9 }}>
        {features.map((f) => (
          <li key={f} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 14, color: "#334155" }}>
            <Check size={15} style={{ color: "#6366f1", flexShrink: 0, marginTop: 2 }} />
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div style={{ marginTop: "auto", paddingTop: 8 }}>
        {!current ? (
          <a
            href={`/api/billing/checkout?plan=${checkoutPlan}`}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: "11px 18px", background: featured ? "#6366f1" : "#ffffff",
              color: featured ? "#ffffff" : "#0f172a", borderRadius: 8,
              border: featured ? "none" : "1px solid #e2e8f0",
              fontSize: 14, fontWeight: 600, textDecoration: "none",
            }}
          >
            Get Tallei {name} <ArrowRight size={14} />
          </a>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "11px 18px", background: "#f1f5f9", color: "#64748b", borderRadius: 8, fontSize: 14, fontWeight: 600 }}>
            Current Plan
          </div>
        )}
      </div>
    </div>
  );
}

// Simple alert dialog — no shadcn required
function AlertDialog({
  open, title, description, confirmLabel, cancelLabel, onConfirm, onCancel, danger = false,
}: {
  open: boolean; title: string; description: string;
  confirmLabel: string; cancelLabel: string;
  onConfirm: () => void; onCancel: () => void; danger?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    const items = getFocusable(dialogRef.current);
    items[items.length - 1]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
      if (e.key !== "Tab") return;
      const els = getFocusable(dialogRef.current);
      if (!els.length) { e.preventDefault(); return; }
      const first = els[0], last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) { if (!active || active === first) { e.preventDefault(); last.focus(); } }
      else { if (!active || active === last) { e.preventDefault(); first.focus(); } }
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
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="alert-title"
        aria-describedby="alert-desc"
        ref={dialogRef}
        style={{ width: "min(420px, 100%)", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 24, display: "flex", flexDirection: "column", gap: 12 }}
      >
        <h3 id="alert-title" style={{ margin: 0, fontFamily: "DM Sans, sans-serif", fontWeight: 700, fontSize: 17, color: "#0f172a" }}>
          {title}
        </h3>
        <p id="alert-desc" style={{ margin: 0, fontSize: 14, color: "#64748b", lineHeight: 1.6 }}>
          {description}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #e2e8f0", background: "#ffffff", color: "#475569", fontSize: 14, fontWeight: 500, cursor: "pointer" }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{ padding: "8px 16px", borderRadius: 8, border: danger ? "1px solid #fca5a5" : "1px solid #6366f1", background: danger ? "#fff1f2" : "#6366f1", color: danger ? "#b91c1c" : "#ffffff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function InvoiceStatusBadge({ status, refunded }: { status: string; refunded: boolean }) {
  if (refunded) return <span style={{ fontSize: 12, fontWeight: 600, color: "#7c3aed", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 6, padding: "2px 8px" }}>Refunded</span>;
  if (status === "paid") return <span style={{ fontSize: 12, fontWeight: 600, color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: "2px 8px" }}>Paid</span>;
  if (status === "failed" || status === "payment_failed") return <span style={{ fontSize: 12, fontWeight: 600, color: "#b91c1c", background: "#fff1f2", border: "1px solid #fecaca", borderRadius: 6, padding: "2px 8px" }}>Failed</span>;
  if (status === "pending") return <span style={{ fontSize: 12, fontWeight: 600, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "2px 8px" }}>Pending</span>;
  if (status === "void") return <span style={{ fontSize: 12, fontWeight: 600, color: "#475569", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "2px 8px" }}>Void</span>;
  return <span style={{ fontSize: 12, fontWeight: 600, color: "#475569", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "2px 8px" }}>{status}</span>;
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
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ height: 56, background: "#f1f5f9", borderRadius: 10, animation: "pulse 1.5s ease-in-out infinite" }} />
        ))}
      </div>
    );
  }

  if (error) {
    return <div style={{ fontSize: 14, color: "#dc2626" }}>{error}</div>;
  }

  if (!invoices || invoices.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "48px 0", color: "#94a3b8" }}>
        <Receipt size={32} style={{ marginBottom: 12, opacity: 0.4 }} />
        <p style={{ margin: 0, fontSize: 14 }}>No invoices yet</p>
      </div>
    );
  }

  const failed = invoices.filter((inv) => inv.status === "failed" || inv.status === "payment_failed");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {failed.length > 0 && (
        <div style={{ border: "1px solid #fecaca", borderRadius: 10, padding: "12px 16px", background: "#fff8f8", display: "flex", alignItems: "flex-start", gap: 10 }}>
          <AlertTriangle size={16} style={{ color: "#dc2626", flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#991b1b", marginBottom: 2 }}>
              {failed.length} payment{failed.length > 1 ? "s" : ""} failed
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "#7f1d1d" }}>
              Please update your payment details to keep your subscription active.
            </p>
          </div>
          <a href="/api/billing/payment-method" style={{ marginLeft: "auto", flexShrink: 0, fontSize: 13, fontWeight: 600, color: "#b91c1c", textDecoration: "none", padding: "6px 12px", border: "1px solid #fca5a5", borderRadius: 8, background: "#ffffff", display: "inline-flex", alignItems: "center", gap: 4 }}>
            Update card <ChevronRight size={13} />
          </a>
        </div>
      )}

      <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
              <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 600, color: "#475569", fontSize: 12 }}>Invoice</th>
              <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 600, color: "#475569", fontSize: 12 }}>Date</th>
              <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 600, color: "#475569", fontSize: 12 }}>Amount</th>
              <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 600, color: "#475569", fontSize: 12 }}>Status</th>
              <th style={{ padding: "10px 16px", textAlign: "right", fontWeight: 600, color: "#475569", fontSize: 12 }}></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv, i) => (
              <tr key={inv.id} style={{ borderBottom: i < invoices.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                <td style={{ padding: "12px 16px", color: "#0f172a", fontWeight: 500 }}>
                  {inv.invoiceNumber ? `#${inv.invoiceNumber}` : "—"}
                  {inv.billingReason && (
                    <span style={{ marginLeft: 8, fontSize: 12, color: "#94a3b8" }}>
                      {inv.billingReason === "initial" ? "New subscription" : inv.billingReason === "renewal" ? "Renewal" : inv.billingReason}
                    </span>
                  )}
                </td>
                <td style={{ padding: "12px 16px", color: "#475569" }}>
                  {inv.createdAt ? new Date(inv.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—"}
                </td>
                <td style={{ padding: "12px 16px", color: "#0f172a", fontWeight: 500 }}>
                  {inv.total}
                  {inv.cardLastFour && (
                    <span style={{ marginLeft: 8, fontSize: 12, color: "#94a3b8" }}>·· {inv.cardLastFour}</span>
                  )}
                </td>
                <td style={{ padding: "12px 16px" }}>
                  <InvoiceStatusBadge status={inv.status} refunded={inv.refunded} />
                </td>
                <td style={{ padding: "12px 16px", textAlign: "right" }}>
                  {(inv.receiptUrl || inv.invoiceUrl) && (
                    <a
                      href={inv.receiptUrl ?? inv.invoiceUrl ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 13, color: "#6366f1", textDecoration: "none", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 4 }}
                    >
                      Receipt <ExternalLink size={12} />
                    </a>
                  )}
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
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [billingAction, setBillingAction] = useState<"cancel" | "resume" | null>(null);
  const [isManageModalOpen, setIsManageModalOpen] = useState(false);
  const [showCancelAlert, setShowCancelAlert] = useState(false);
  const [activeTab, setActiveTab] = useState<"subscription" | "invoices">("subscription");
  const [invoicesLoaded, setInvoicesLoaded] = useState(false);
  const manageModalRef = useRef<HTMLDivElement | null>(null);

  async function fetchStatus() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/status");
      if (!res.ok) throw new Error("Failed to load billing info");
      const data: BillingStatus = await res.json();
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void fetchStatus(); }, []);

  useEffect(() => {
    if (!isManageModalOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    getFocusable(manageModalRef.current)[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeManageModal(); return; }
      if (e.key !== "Tab") return;
      const items = getFocusable(manageModalRef.current);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? manageModalRef.current?.contains(active) : false;
      if (e.shiftKey) { if (!inside || active === first) { e.preventDefault(); last.focus(); } }
      else { if (!inside || active === last) { e.preventDefault(); first.focus(); } }
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
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ maxWidth: 960, width: "100%", margin: "0 auto", padding: "32px 24px", flex: 1, display: "flex", flexDirection: "column" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
          <div>
            <h1 style={{ fontFamily: "DM Sans, sans-serif", fontWeight: 700, fontSize: 24, color: "#0f172a", marginBottom: 2 }}>
              Billing
            </h1>
            <p style={{ fontSize: 14, color: "#64748b", margin: 0 }}>Manage your plan and usage</p>
          </div>
          <button
            onClick={() => void fetchStatus()}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", background: "#ffffff", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13, cursor: "pointer", fontWeight: 500 }}
          >
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, marginBottom: 24, borderBottom: "1px solid #e2e8f0" }}>
          {(["subscription", "invoices"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab);
                if (tab === "invoices") setInvoicesLoaded(true);
              }}
              style={{
                padding: "8px 16px",
                fontSize: 14,
                fontWeight: activeTab === tab ? 600 : 500,
                color: activeTab === tab ? "#0f172a" : "#64748b",
                background: "transparent",
                border: "none",
                borderBottom: activeTab === tab ? "2px solid #6366f1" : "2px solid transparent",
                marginBottom: -1,
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {tab === "subscription" ? "Subscription" : "Invoices"}
            </button>
          ))}
        </div>

        {error && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: 12, marginBottom: 20, fontSize: 13, color: "#dc2626" }}>
            {error}
          </div>
        )}

        {/* Subscription tab */}
        {activeTab === "subscription" && (
          loading && !status ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[1, 2].map((i) => (
                <div key={i} style={{ height: 100, background: "#f1f5f9", borderRadius: 10, animation: "pulse 1.5s ease-in-out infinite" }} />
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 24, flex: 1 }}>
              {/* Current plan banner */}
              <div
                style={{
                  background: planColor.bg,
                  border: `1px solid ${planColor.border}`,
                  borderRadius: 10,
                  padding: "16px 20px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 9, background: "#ffffff", display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${planColor.border}` }}>
                    <Zap size={18} style={{ color: planColor.text }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, color: planColor.text, fontWeight: 600 }}>{PLAN_LABELS[plan]} Plan</div>
                    {status?.cancelAtPeriodEnd && status.currentPeriodEnd && (
                      <div style={{ fontSize: 13, color: "#dc2626", marginTop: 1 }}>
                        Cancels {new Date(status.currentPeriodEnd).toLocaleDateString()}
                      </div>
                    )}
                    {!status?.cancelAtPeriodEnd && status?.currentPeriodEnd && (
                      <div style={{ fontSize: 13, color: planColor.text, opacity: 0.7, marginTop: 1 }}>
                        Renews {new Date(status.currentPeriodEnd).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </div>
                {plan !== "free" && (
                  <button
                    type="button"
                    onClick={() => setIsManageModalOpen(true)}
                    style={{ fontSize: 13, color: "#334155", fontWeight: 500, padding: "7px 12px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#ffffff", cursor: "pointer" }}
                  >
                    Manage
                  </button>
                )}
              </div>

              {/* Usage */}
              <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "20px 24px" }}>
                <h2 style={{ fontFamily: "DM Sans, sans-serif", fontWeight: 600, fontSize: 15, color: "#0f172a", marginBottom: 18, marginTop: 0 }}>
                  This month&apos;s usage
                </h2>
                {status && (
                  <>
                    <UsageBar used={status.usage.savesUsed} limit={status.usage.savesLimit} label="Memory saves" />
                    <UsageBar used={status.usage.recallsUsed} limit={status.usage.recallsLimit} label="Memory recalls" />
                  </>
                )}
              </div>

              {/* Plan cards */}
              {plan !== "power" && (
                <div>
                  <h2 style={{ fontFamily: "DM Sans, sans-serif", fontWeight: 600, fontSize: 15, color: "#0f172a", marginBottom: 16, marginTop: 0 }}>
                    {plan === "free" ? "Choose a plan" : "Available upgrade"}
                  </h2>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
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
                </div>
              )}

              <p style={{ fontSize: 13, color: "#94a3b8", marginTop: "auto" }}>
                Plans are designed for high-volume daily use. Fair-use protections apply.
              </p>
            </div>
          )
        )}

        {/* Invoices tab — only mounts after first click */}
        {activeTab === "invoices" && invoicesLoaded && <InvoicesTab />}
      </div>

      {/* Manage billing modal */}
      {isManageModalOpen && plan !== "free" && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeManageModal(); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="billing-manage-title"
            ref={manageModalRef}
            style={{ width: "min(520px, 100%)", borderRadius: 12, border: "1px solid #e2e8f0", background: "#ffffff", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div>
                <h2 id="billing-manage-title" style={{ margin: 0, fontFamily: "DM Sans, sans-serif", fontWeight: 700, fontSize: 20, color: "#0f172a" }}>
                  Manage billing
                </h2>
                <p style={{ margin: "4px 0 0 0", fontSize: 14, color: "#64748b" }}>
                  {currentPlanLabel} plan · payments secured by Stripe
                </p>
              </div>
              <button
                type="button"
                onClick={closeManageModal}
                style={{ width: 30, height: 30, borderRadius: 7, border: "1px solid #e2e8f0", background: "#ffffff", color: "#64748b", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <CreditCard size={15} style={{ color: "#64748b", flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>Payment details</div>
                  <p style={{ margin: "2px 0 0 0", fontSize: 13, color: "#64748b" }}>Update your card and billing details.</p>
                </div>
              </div>
              <a href="/api/billing/payment-method" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: "#0f172a", textDecoration: "none", fontWeight: 600, padding: "7px 12px", borderRadius: 8, border: "1px solid #e2e8f0", background: "#ffffff", whiteSpace: "nowrap" }}>
                Update details <ExternalLink size={12} />
              </a>
            </div>

            <div style={{ border: "1px solid #fecaca", borderRadius: 10, padding: "14px 16px", background: "#fff8f8" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#991b1b" }}>
                  {status?.cancelAtPeriodEnd ? "Cancellation scheduled" : "Cancel subscription"}
                </div>
                {!status?.cancelAtPeriodEnd && (
                  <span style={{ fontSize: 12, color: "#78350f", background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 6, padding: "2px 8px" }}>
                    takes effect at period end
                  </span>
                )}
              </div>
              <p style={{ margin: "0 0 12px 0", fontSize: 13, color: "#7f1d1d" }}>
                {status?.cancelAtPeriodEnd && status.currentPeriodEnd
                  ? `Your plan ends on ${new Date(status.currentPeriodEnd).toLocaleDateString()}.`
                  : "Access stays active until the end of your current billing period."}
              </p>

              {status?.cancelAtPeriodEnd ? (
                <button
                  onClick={() => void resumeSubscription()}
                  disabled={billingAction !== null}
                  style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #86efac", background: "#f0fdf4", color: "#166534", fontSize: 13, fontWeight: 600, cursor: billingAction !== null ? "not-allowed" : "pointer", opacity: billingAction !== null ? 0.6 : 1 }}
                >
                  {billingAction === "resume" ? "Resuming…" : "Resume subscription"}
                </button>
              ) : (
                <button
                  onClick={() => setShowCancelAlert(true)}
                  disabled={billingAction !== null}
                  style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #fca5a5", background: "#ffffff", color: "#b91c1c", fontSize: 13, fontWeight: 600, cursor: billingAction !== null ? "not-allowed" : "pointer", opacity: billingAction !== null ? 0.6 : 1 }}
                >
                  Cancel subscription
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Cancel confirmation alert dialog */}
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
