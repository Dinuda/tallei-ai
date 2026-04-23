"use client";

import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, Sparkles, X } from "lucide-react";
import "./logged-in-light.css";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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
  activity: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M1.8 7.7H4.7L6.1 4.2L8.2 10.3L10 7.1H13.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

const NAV: NavSection[] = [
  {
    items: [
      { id: "memories", label: "Memories", href: "/dashboard", icon: ICONS.memories },
      { id: "documents", label: "Documents", href: "/dashboard/documents", icon: ICONS.documents },
      { id: "connectors", label: "AI Assitants", href: "/dashboard/setup", icon: ICONS.connectors },
      { id: "billing", label: "Billing", href: "/dashboard/billing", icon: ICONS.billing },
    ],
  },
  {
    label: "DEVELOPER",
    items: [{ id: "activity", label: "Activity", href: "/dashboard/mcp-events", icon: ICONS.activity }],
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

function NavSectionContent({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="space-y-4 mt-4" style={{ fontFamily: "var(--font-title), sans-serif" }}>
      {NAV.map((section) => (
        <div key={section.label ?? "root"} className="space-y-0.5">
          {section.label ? (
            <p className="px-2 text-[10px] font-semibold tracking-[0.1em] text-slate-400 uppercase">{section.label}</p>
          ) : null}
          {section.items.map((item) => {
            const active = isActive(pathname, item);
            return (
              <Link
                key={item.id}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  "group relative flex h-8 items-center gap-2 px-2.5 text-[13px] font-medium transition-colors",
                  active
                    ? "text-slate-900"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-900 rounded-lg"
                )}
              >
                {active && (
                  <>
                    {/* Main background */}
                    <span className="absolute inset-y-0 left-0 w-full bg-slate-100" 
                      style={{ borderRadius: "8px 0 0 8px" }}
                    />
                  
                  </>
                )}
                <span className="relative z-10 flex items-center gap-2">
                  {item.icon}
                  <span>{item.label}</span>
                </span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const { data: session } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    document.documentElement.classList.remove("dark");
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileOpen(false);
        setProfileOpen(false);
      }
    };
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
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  const initials = getInitials(session?.user?.name, session?.user?.email);
  return (
    <div className="logged-in-shell-light min-h-screen overflow-x-hidden bg-white text-slate-900">
      <header className="fixed inset-x-0 top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="flex h-14 w-full items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              onClick={() => setMobileOpen((v) => !v)}
            >
              {mobileOpen ? <X size={16} /> : <Menu size={16} />}
            </Button>
            <Link href="/dashboard" className="flex items-center">
              <img src="/tallei.svg" alt="Tallei" className="h-8 w-auto" />
            </Link>
          </div>

          <div className="flex items-center gap-2 pl-3 sm:pl-4">
            <div className="hidden items-center gap-1 rounded-lg border border-amber-100 bg-amber-50 px-2.5 py-1 text-[12px] font-medium text-amber-900 lg:inline-flex">
              <Sparkles className="size-3.5" />
              <span>14 day free trial</span>
            </div>

            <Button
              asChild
              size="sm"
              className="bg-amber-500 text-amber-950 hover:bg-amber-400 focus-visible:border-amber-500 focus-visible:ring-amber-300 rounded-lg"
            >
              <Link href="/dashboard/billing">Upgrade</Link>
            </Button>

            <div className="relative ml-1 border-l border-slate-200 pl-3">
              <button
                type="button"
                onClick={() => setProfileOpen((v) => !v)}
                className="rounded-full"
                aria-label="Toggle profile menu"
              >
                <Avatar size="sm">
                  <AvatarImage src={session?.user?.image ?? undefined} alt={session?.user?.name ?? "User"} />
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              </button>

              {profileOpen ? (
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-40 cursor-default"
                    onClick={() => setProfileOpen(false)}
                    aria-label="Close profile menu"
                  />
                  <Card className="absolute right-0 top-[calc(100%+10px)] z-50 w-56 border-slate-200 bg-white shadow-lg">
                    <CardContent className="space-y-3 p-2">
                      <div className="rounded-md border px-3 py-2">
                        <p className="text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">Signed in as</p>
                        <p className="truncate text-sm font-medium text-foreground">{session?.user?.email}</p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full justify-start"
                        onClick={() => signOut({ callbackUrl: "/login" })}
                      >
                        Sign out
                      </Button>
                    </CardContent>
                  </Card>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {mobileOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        />
      ) : null}

      <aside
        className={cn(
          "fixed bottom-0 left-0 top-14 z-40 w-[248px] border-r border-slate-200 bg-white px-3 py-3 transition-transform md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
        aria-label="Navigation"
      >
        <NavSectionContent pathname={pathname} onNavigate={() => setMobileOpen(false)} />
      </aside>

      <main className="min-h-screen min-w-0 bg-[#f4f4f4] pt-14 md:ml-[248px]">
        <div className="mx-auto w-full max-w-7xl">
          {children}
        </div>
      </main>
    </div>
  );
}
