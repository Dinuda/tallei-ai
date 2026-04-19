"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";

const HIDDEN_PREFIXES = ["/dashboard", "/login", "/register", "/authorize"];

export function TopNav() {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const isHome = pathname === "/";
  const isLoading = status === "loading";
  const isAuthenticated = status === "authenticated" && !!session;
  const userLabel = session?.user?.name ?? session?.user?.email ?? "Account";
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || "U";
  const [scrolled, setScrolled] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    if (!isHome) return;
    const onScroll = () => setScrolled(window.scrollY > window.innerHeight * 0.7);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isHome]);

  if (!pathname) return null;
  const isHidden = HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (isHidden) return null;

  const transparent = isHome && !scrolled;

  return (
    <nav
      className={`site-navbar${transparent ? " site-navbar-transparent" : ""}`}
      aria-label="Primary"
      style={{ transition: "background 0.3s ease, border-color 0.3s ease" }}
    >
      <div className="container site-nav-inner">
        <Link href="/" className="site-logo">
          <img src="/tallei.svg" alt="Tallei Logo" style={{ height: "24px", width: "auto" }} />
        </Link>

        <div className="site-nav-actions">
          <a
            href="https://github.com/Dinuda/tallei-ai"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-open-source-link"
          >
            Open Source
          </a>
          {isLoading ? (
            <div style={{ width: "80px" }} aria-hidden="true" />
          ) : isAuthenticated ? (
            <>
              <Link href="/dashboard/setup" className="btn btn-ghost">
                Setup
              </Link>
              <Link href="/dashboard" className="btn btn-ghost">
                Dashboard
              </Link>
              <div style={{ position: "relative" }}>
                <button
                  type="button"
                  onClick={() => setProfileOpen((v) => !v)}
                  aria-label={`Open ${userLabel}`}
                  title={userLabel}
                  style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
                >
                  <Avatar size="sm">
                    <AvatarImage src={session?.user?.image ?? undefined} alt={userLabel} />
                    <AvatarFallback>{userInitial}</AvatarFallback>
                  </Avatar>
                </button>
                {profileOpen && (
                  <>
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 290 }}
                      onClick={() => setProfileOpen(false)}
                    />
                    <div
                      style={{
                        position: "absolute",
                        top: "calc(100% + 10px)",
                        right: 0,
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "12px",
                        boxShadow: "var(--shadow-md)",
                        minWidth: "220px",
                        zIndex: 300,
                        padding: "0.4rem",
                        animation: "fadeIn 0.15s ease-out",
                      }}
                    >
                      <div
                        style={{
                          padding: "0.6rem 0.8rem",
                          borderBottom: "1px solid var(--border-light)",
                          marginBottom: "0.4rem",
                        }}
                      >
                        <p
                          style={{
                            fontSize: "0.72rem",
                            color: "var(--text-muted)",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            margin: 0,
                            marginBottom: "0.2rem",
                          }}
                        >
                          Signed in as
                        </p>
                        <p
                          style={{
                            fontSize: "0.85rem",
                            color: "var(--text)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            margin: 0,
                            fontWeight: 500,
                          }}
                        >
                          {session?.user?.email}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => signOut({ callbackUrl: "/login" })}
                        className="btn btn-ghost"
                        style={{
                          width: "100%",
                          justifyContent: "flex-start",
                          color: "var(--text-2)",
                          padding: "0.5rem 0.8rem",
                        }}
                      >
                        Log out
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <Link href="/login" className="btn btn-primary btn-sm">
              Sign in
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
