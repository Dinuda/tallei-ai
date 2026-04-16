"use client";

import { useEffect, useState } from "react";
import { Zap, CheckCircle2, ArrowRight, RefreshCw, ExternalLink } from "lucide-react";

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

const PLAN_LABELS: Record<string, string> = { free: "Free", pro: "Pro", power: "Power" };

const PLAN_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  free:  { bg: "var(--accent-light)", text: "var(--text-2)",  border: "var(--border)" },
  pro:   { bg: "#f0fdf4",            text: "#166534",         border: "#bbf7d0" },
  power: { bg: "#faf5ff",            text: "#6b21a8",         border: "#e9d5ff" },
};

function UsageBar({ used, limit, label }: { used: number; limit: number | null; label: string }) {
  if (limit === null) {
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>{label}</span>
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Unlimited</span>
        </div>
        <div style={{ height: 6, background: "var(--border-light)", borderRadius: 999 }}>
          <div style={{ height: "100%", width: "100%", background: "var(--accent)", borderRadius: 999, opacity: 0.3 }} />
        </div>
      </div>
    );
  }

  const pct = Math.min(100, (used / limit) * 100);
  const isNearLimit = pct >= 80;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 13, color: "var(--text-2)" }}>{label}</span>
        <span style={{ fontSize: 13, color: isNearLimit ? "#dc2626" : "var(--text-muted)" }}>
          {used} / {limit}
        </span>
      </div>
      <div style={{ height: 6, background: "var(--border-light)", borderRadius: 999 }}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: isNearLimit ? "#dc2626" : "var(--accent)",
            borderRadius: 999,
            transition: "width 0.4s var(--ease-out)",
          }}
        />
      </div>
    </div>
  );
}

function PlanCard({
  name,
  price,
  features,
  current,
  checkoutPlan,
}: {
  name: string;
  price: string;
  features: string[];
  current: boolean;
  checkoutPlan: string;
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: current ? "2px solid var(--accent)" : "1px solid var(--border-light)",
        borderRadius: "var(--radius-lg)",
        padding: 24,
        flex: 1,
        minWidth: 220,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        boxShadow: current ? "0 0 0 3px rgba(17,24,39,.06)" : "var(--shadow-sm)",
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontFamily: "DM Sans, sans-serif", fontWeight: 700, fontSize: 16, color: "var(--text)" }}>
            {name}
          </span>
          {current && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                background: "var(--accent)",
                color: "#fff",
                borderRadius: "var(--radius-pill)",
                padding: "2px 8px",
              }}
            >
              Current
            </span>
          )}
        </div>
        <div style={{ fontFamily: "DM Sans, sans-serif", fontWeight: 700, fontSize: 26, color: "var(--text)" }}>
          {price}
          {price !== "Free" && (
            <span style={{ fontSize: 14, fontWeight: 400, color: "var(--text-muted)" }}>/mo</span>
          )}
        </div>
      </div>

      <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {features.map((f) => (
          <li key={f} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-2)" }}>
            <CheckCircle2 size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
            {f}
          </li>
        ))}
      </ul>

      {!current && (
        <a
          href={`/api/billing/checkout?plan=${checkoutPlan}`}
          style={{
            marginTop: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "10px 16px",
            background: "var(--accent)",
            color: "#fff",
            borderRadius: "var(--radius-md)",
            fontSize: 13,
            fontWeight: 600,
            textDecoration: "none",
            transition: "opacity var(--t-fast)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.88")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
        >
          Upgrade <ArrowRight size={14} />
        </a>
      )}
    </div>
  );
}

export default function BillingPage() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const plan = status?.plan ?? "free";
  const planColor = PLAN_COLORS[plan] ?? PLAN_COLORS.free;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "32px 24px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 }}>
        <div>
          <h1 style={{ fontFamily: "DM Sans, sans-serif", fontWeight: 700, fontSize: 22, color: "var(--text)", marginBottom: 4 }}>
            Billing
          </h1>
          <p style={{ fontSize: 14, color: "var(--text-muted)" }}>Manage your plan and usage</p>
        </div>
        <button
          onClick={() => void fetchStatus()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            background: "var(--accent-light)",
            color: "var(--text-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          <RefreshCw size={13} />
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "var(--radius-md)", padding: 14, marginBottom: 24, fontSize: 13, color: "#dc2626" }}>
          {error}
        </div>
      )}

      {loading && !status ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {[1, 2].map((i) => (
            <div key={i} style={{ height: 120, background: "var(--accent-light)", borderRadius: "var(--radius-lg)", animation: "pulse 1.5s ease-in-out infinite" }} />
          ))}
        </div>
      ) : (
        <>
          {/* Current plan banner */}
          <div
            style={{
              background: planColor.bg,
              border: `1px solid ${planColor.border}`,
              borderRadius: "var(--radius-lg)",
              padding: "20px 24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 28,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Zap size={20} style={{ color: planColor.text }} />
              <div>
                <div style={{ fontSize: 13, color: planColor.text, fontWeight: 600 }}>
                  {PLAN_LABELS[plan]} Plan
                </div>
                {status?.cancelAtPeriodEnd && status.currentPeriodEnd && (
                  <div style={{ fontSize: 12, color: "#dc2626", marginTop: 2 }}>
                    Cancels on {new Date(status.currentPeriodEnd).toLocaleDateString()}
                  </div>
                )}
                {!status?.cancelAtPeriodEnd && status?.currentPeriodEnd && (
                  <div style={{ fontSize: 12, color: planColor.text, opacity: 0.7, marginTop: 2 }}>
                    Renews {new Date(status.currentPeriodEnd).toLocaleDateString()}
                  </div>
                )}
              </div>
            </div>
            {plan !== "free" && (
              <a
                href="/api/billing/portal"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 13,
                  color: planColor.text,
                  textDecoration: "none",
                  fontWeight: 500,
                }}
              >
                Manage <ExternalLink size={12} />
              </a>
            )}
          </div>

          {/* Usage */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border-light)",
              borderRadius: "var(--radius-lg)",
              padding: 24,
              marginBottom: 28,
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <h2 style={{ fontFamily: "DM Sans, sans-serif", fontWeight: 600, fontSize: 15, color: "var(--text)", marginBottom: 20 }}>
              This month&apos;s usage
            </h2>
            {status && (
              <>
                <UsageBar
                  used={status.usage.savesUsed}
                  limit={status.usage.savesLimit}
                  label="Memory saves"
                />
                <UsageBar
                  used={status.usage.recallsUsed}
                  limit={status.usage.recallsLimit}
                  label="Memory recalls"
                />
              </>
            )}
          </div>

          {/* Plan cards */}
          {plan === "free" && (
            <>
              <h2 style={{ fontFamily: "DM Sans, sans-serif", fontWeight: 600, fontSize: 15, color: "var(--text)", marginBottom: 16 }}>
                Upgrade your plan
              </h2>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <PlanCard
                  name="Free"
                  price="Free"
                  features={["50 saves/month", "200 recalls/month", "All 3 AI platforms"]}
                  current={true}
                  checkoutPlan="free"
                />
                <PlanCard
                  name="Pro"
                  price="$9"
                  features={["Unlimited saves", "Unlimited recalls", "All 3 AI platforms", "Graph insights"]}
                  current={false}
                  checkoutPlan="pro"
                />
                <PlanCard
                  name="Power"
                  price="$19"
                  features={["Everything in Pro", "API access", "Memory export", "Priority support"]}
                  current={false}
                  checkoutPlan="power"
                />
              </div>
            </>
          )}

          {plan === "pro" && (
            <>
              <h2 style={{ fontFamily: "DM Sans, sans-serif", fontWeight: 600, fontSize: 15, color: "var(--text)", marginBottom: 16 }}>
                Available upgrade
              </h2>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <PlanCard
                  name="Power"
                  price="$19"
                  features={["Everything in Pro", "API access", "Memory export", "Priority support"]}
                  current={false}
                  checkoutPlan="power"
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
