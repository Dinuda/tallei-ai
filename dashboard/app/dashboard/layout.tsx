"use client";

import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar";

type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: React.ReactNode;
};

type NavSection = {
  label?: string;
  items: NavItem[];
};

const ICONS = {
  billing: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <rect x="1.5" y="3.5" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 6.5h12" stroke="currentColor" strokeWidth="1.2" />
      <rect x="3.5" y="8.5" width="3" height="1.5" rx=".5" fill="currentColor" />
    </svg>
  ),
  memories: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M2 3.5C2 2.7 2.7 2 3.5 2h8C12.3 2 13 2.7 13 3.5v8c0 .8-.7 1.5-1.5 1.5h-8C2.7 13 2 12.3 2 11.5v-8Z" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 5.5h5M5 7.5h5M5 9.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  documents: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M4 2h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 2v3h3M5 8h5M5 10h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  connectors: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M5.2 2V5.2M9.8 2V5.2M4.1 5.2H10.9V7.3C10.9 9.2 9.4 10.7 7.5 10.7C5.6 10.7 4.1 9.2 4.1 7.3V5.2Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 10.7V13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  key: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="5.2" cy="9" r="3.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 6.2L13.2 1M13.2 1H10.6M13.2 1V3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  activity: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M1.8 7.7H4.7L6.1 4.2L8.2 10.3L10 7.1H13.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  signOut: (
    <svg width="12" height="12" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M6 13H2.5A1.5 1.5 0 0 1 1 11.5v-8A1.5 1.5 0 0 1 2.5 2H6M10 10.5l3.5-3-3.5-3M13.5 7.5H6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

const NAV: NavSection[] = [
  {
    items: [
      { id: "memories", label: "Memories", href: "/dashboard", icon: ICONS.memories },
      { id: "documents", label: "Documents", href: "/dashboard/documents", icon: ICONS.documents },
      { id: "connectors", label: "Connectors", href: "/dashboard/setup", icon: ICONS.connectors },
      { id: "billing", label: "Billing", href: "/dashboard/billing", icon: ICONS.billing },
    ],
  },
  {
    label: "DEVELOPER",
    items: [
      { id: "activity", label: "Activity", href: "/dashboard/mcp-events", icon: ICONS.activity },
    ],
  },
];

function isActive(pathname: string, item: NavItem) {
  if (item.href === "/dashboard") return pathname === "/dashboard";
  return pathname.startsWith(item.href);
}

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return "?";
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const { data: session } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setMobileOpen(false);
      setProfileOpen(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  const initials = getInitials(session?.user?.name, session?.user?.email);

  return (
    <div className="dashboard-shell">
      {/* ── Top bar ── */}
      <header className="dashboard-topbar">
        <div className="dashboard-topbar-inner">
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            {/* Mobile hamburger */}
            <button
              type="button"
              className="dashboard-mobile-menu-btn"
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              onClick={() => setMobileOpen((v) => !v)}
            >
              {mobileOpen ? (
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
                  <path d="M2.5 2.5l10 10M12.5 2.5l-10 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
                  <path d="M2 4h11M2 7.5h11M2 11h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              )}
            </button>
            <Link href="/dashboard" style={{ display: "flex", alignItems: "center" }}>
              <img src="/tallei.svg" alt="Tallei" style={{ height: "36px", width: "auto" }} />
            </Link>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", borderLeft: "1px solid var(--border)", paddingLeft: "1rem", position: "relative" }}>
            <button
              type="button"
              onClick={() => setProfileOpen((v) => !v)}
              style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
              aria-label="Toggle profile menu"
            >
              <Avatar size="sm">
                <AvatarImage src={session?.user?.image ?? undefined} alt={session?.user?.name ?? "User"} />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            </button>

            {profileOpen && (
              <>
                <div 
                  style={{ position: "fixed", inset: 0, zIndex: 290 }} 
                  onClick={() => setProfileOpen(false)} 
                />
                <div style={{
                  position: "absolute",
                  top: "calc(100% + 10px)",
                  right: 0,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-lg)",
                  boxShadow: "var(--shadow-md)",
                  minWidth: "220px",
                  zIndex: 300,
                  padding: "0.4rem",
                  animation: "fadeIn 0.15s ease-out"
                }}>
                  <div style={{ padding: "0.6rem 0.8rem", borderBottom: "1px solid var(--border-light)", marginBottom: "0.4rem" }}>
                    <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", margin: 0, marginBottom: "0.2rem" }}>Signed in as</p>
                    <p style={{ fontSize: "0.85rem", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: 0, fontWeight: 500 }}>{session?.user?.email}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => signOut({ callbackUrl: "/login" })}
                    className="btn btn-ghost"
                    style={{ width: "100%", justifyContent: "flex-start", color: "var(--text-2)", padding: "0.5rem 0.8rem" }}
                  >
                    {ICONS.signOut}
                    <span style={{ marginLeft: "0.3rem" }}>Sign out</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── Mobile backdrop ── */}
      <button
        type="button"
        aria-label="Close navigation"
        className={`sidebar-backdrop ${mobileOpen ? "open" : ""}`}
        onClick={() => setMobileOpen(false)}
      />

      {/* ── Sidebar ── */}
      <aside className={`dashboard-sidebar ${mobileOpen ? "open" : ""}`} aria-label="Navigation">
        <nav className="sidebar-nav" style={{ paddingTop: "0.25rem" }}>
          {NAV.map((section) => (
            <div key={section.label ?? "root"} style={{ marginBottom: section.label ? "0.1rem" : "0" }}>
              {section.label && <p className="sidebar-label">{section.label}</p>}
              {section.items.map((item) => {
                const active = isActive(pathname, item);
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    className={`sidebar-link ${active ? "active" : ""}`}
                    onClick={() => setMobileOpen(false)}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                    {active && <span className="sidebar-link-dot" />}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* ── Main ── */}
      <main className="dashboard-main">
        <div className="dashboard-content-wrap animate-fade-up">{children}</div>
      </main>

      <nav
        className={`dashboard-mobile-nav${mobileOpen ? " hidden" : ""}`}
        aria-label="Dashboard mobile navigation"
      >
        {NAV[0].items.map((item) => {
          const active = isActive(pathname, item);
          return (
            <Link
              key={item.id}
              href={item.href}
              className={`dashboard-mobile-nav-link ${active ? "active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
