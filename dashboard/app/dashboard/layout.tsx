"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type SidebarItem = {
  id: string;
  label: string;
  href?: string;
  activePaths?: string[];
  icon: React.ReactNode;
  rightIcon?: React.ReactNode;
};

type SidebarSection = {
  label?: string;
  items: SidebarItem[];
};

const ORG_PLAN_LABEL = "FREE";

const ICONS = {
  home: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M2.2 6.1L7.5 1.7L12.8 6.1V13H2.2V6.1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  ),
  file: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M3 1.8H9L12 4.8V13.2H3V1.8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 1.8V4.8H12" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ),
  tag: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M8.8 1.7H13.3V6.2L7.4 12.1L2.9 7.6L8.8 1.7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="10.9" cy="4.1" r="0.8" fill="currentColor" />
    </svg>
  ),
  graph: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="3" cy="7.5" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7.5" cy="3" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12" cy="8.8" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.2 6.3L6.3 4.2M8.7 4.2L10.8 7.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ),
  pulse: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M1.8 7.7H4.7L6.1 4.2L8.2 10.3L10 7.1H13.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  users: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="5.4" cy="5" r="2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10.8" cy="6" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 12.8C2.4 10.8 3.8 9.8 5.4 9.8C7 9.8 8.4 10.8 8.8 12.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  plug: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M5.2 2V5.2M9.8 2V5.2M4.1 5.2H10.9V7.3C10.9 9.2 9.4 10.7 7.5 10.7C5.6 10.7 4.1 9.2 4.1 7.3V5.2Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 10.7V13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  arrow: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M2.3 7.5H12.7M8.9 3.7L12.7 7.5L8.9 11.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  key: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="5.2" cy="9" r="3.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 6.2L13.2 1M13.2 1H10.6M13.2 1V3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  cpu: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <rect x="4.2" y="4.2" width="6.6" height="6.6" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.8 5.2H3.2M1.8 9.8H3.2M11.8 5.2H13.2M11.8 9.8H13.2M5.2 1.8V3.2M9.8 1.8V3.2M5.2 11.8V13.2M9.8 11.8V13.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  cube: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M7.5 1.8L12.4 4.5V10.5L7.5 13.2L2.6 10.5V4.5L7.5 1.8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M7.5 1.8V7.5M12.4 4.5L7.5 7.5L2.6 4.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ),
  team: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="4.6" cy="5.2" r="1.7" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10.4" cy="5.2" r="1.7" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.1 12.5C2.4 10.8 3.4 9.8 4.6 9.8C5.8 9.8 6.8 10.8 7.1 12.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M7.9 12.5C8.2 10.8 9.2 9.8 10.4 9.8C11.6 9.8 12.6 10.8 12.9 12.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  card: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <rect x="1.8" y="3" width="11.4" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.8 5.8H13.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ),
  gear: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="7.5" cy="7.5" r="2.1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7.5 1.9V3.1M7.5 11.9V13.1M1.9 7.5H3.1M11.9 7.5H13.1M3.5 3.5L4.4 4.4M10.6 10.6L11.5 11.5M3.5 11.5L4.4 10.6M10.6 4.4L11.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  lock: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <rect x="4.5" y="6.5" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.5 6.5V4.5C5.5 3.4 6.4 2.5 7.5 2.5C8.6 2.5 9.5 3.4 9.5 4.5V6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  chevronRight: (
    <svg width="12" height="12" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M5.5 3L10.5 7.5L5.5 12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  chevronUpDown: (
    <svg width="12" height="12" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M4 6L7.5 2.5L11 6M4 9L7.5 12.5L11 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  externalLink: (
    <svg width="12" height="12" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M5 2.5H12.5V10M12.5 2.5L2.5 12.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  building: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M3 13.5V3C3 2.4 3.4 2 4 2H11C11.6 2 12 2.4 12 3V13.5M3 13.5H12M3 13.5H1M12 13.5H14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 5H8.5M6.5 8H8.5M6.5 11H8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
};

const NAV_SECTIONS: SidebarSection[] = [
  {
    items: [
      { id: "overview", label: "Overview", href: "/dashboard", icon: ICONS.home },
      { id: "memory", label: "Memory", href: "/dashboard/memory", icon: ICONS.file },
      { id: "graph", label: "Memory Graph", href: "/dashboard/memory-graph", icon: ICONS.graph },
    ],
  },
  {
    label: "DATA",
    items: [
      { id: "connectors", label: "Connectors", href: "/dashboard/setup", icon: ICONS.plug },
    ],
  },
  {
    label: "DEVELOPER",
    items: [
      { id: "api-keys", label: "API Keys", href: "/dashboard/keys", icon: ICONS.key },
      { id: "mcp-events", label: "MCP Events", href: "/dashboard/mcp-events", icon: ICONS.pulse },
    ],
  },
];

function isRouteActive(pathname: string, item: SidebarItem) {
  if (!item.href) return false;
  if (item.href === "/dashboard") return pathname === "/dashboard";
  return pathname.startsWith(item.href);
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };

    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, []);

  useEffect(() => {
    document.body.style.overflow = mobileNavOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileNavOpen]);

  return (
    <div className="dashboard-shell">
      <header className="dashboard-topbar">
        <div className="dashboard-topbar-inner">
          <div style={{ display: "inline-flex", alignItems: "center", gap: "0.72rem", paddingLeft: "0.25rem" }}>
            <img src="/tallei.svg" alt="Tallei Logo" style={{ height: "24px", width: "auto" }} />
          </div>

          <div style={{ display: "inline-flex", alignItems: "center", gap: "1rem" }}>
            <div className="dashboard-topbar-links">
              <a href="https://docs.tallei.ai" target="_blank" rel="noreferrer" className="topbar-link">
                DOCS {ICONS.externalLink}
              </a>
              <a href="mailto:support@tallei.ai" className="topbar-link">SUPPORT</a>
            </div>
            <div className="dashboard-avatar-wrap" style={{ borderLeft: "1px solid #27272a", paddingLeft: "1rem", height: "30px", display: "flex", alignItems: "center" }}>
              <span className="dashboard-avatar" aria-hidden>DY</span>
            </div>
          </div>
        </div>
      </header>

      <button
        type="button"
        aria-label="Close navigation"
        className={`sidebar-backdrop ${mobileNavOpen ? "open" : ""}`}
        onClick={() => setMobileNavOpen(false)}
      />

      <aside className={`dashboard-sidebar ${mobileNavOpen ? "open" : ""}`} aria-label="Dashboard navigation">
       

        <div className="sidebar-search-wrap">
          <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden>
            <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input className="sidebar-search" type="text" placeholder="Search..." readOnly />
          <span className="sidebar-search-kbd">CMD K</span>
        </div>

        <nav className="sidebar-nav">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label || "root"}>
              {section.label && <p className="sidebar-label">{section.label}</p>}
              {section.items.map((item) => {
                const active = isRouteActive(pathname, item);
                const className = `sidebar-link ${active ? "active" : ""} ${item.href ? "" : "placeholder"}`;

                if (item.href) {
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      className={className}
                      onClick={() => setMobileNavOpen(false)}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                      {active && <span className="sidebar-link-dot" />}
                      {item.rightIcon && <span className="sidebar-link-right-icon">{item.rightIcon}</span>}
                    </Link>
                  );
                }

                return (
                  <span key={item.id} className={className} role="link" aria-disabled>
                    {item.icon}
                    <span>{item.label}</span>
                    {item.rightIcon && <span className="sidebar-link-right-icon">{item.rightIcon}</span>}
                  </span>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button
            type="button"
            className="btn btn-ghost sidebar-logout"
            onClick={() => signOut({ callbackUrl: "/login" })}
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
              <path d="M6 13H2.5A1.5 1.5 0 0 1 1 11.5v-8A1.5 1.5 0 0 1 2.5 2H6M10 10.5l3.5-3-3.5-3M13.5 7.5H6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>

      <main className="dashboard-main">
        <div className="dashboard-content-wrap animate-fade-up">{children}</div>
      </main>
    </div>
  );
}
