"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { Menu, X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar";

const HIDDEN_PREFIXES = ["/dashboard", "/login", "/register", "/authorize"];

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
  const isHome = pathname === "/";
  const isLoading = status === "loading";
  const isAuthenticated = status === "authenticated" && !!session;
  const userLabel = session?.user?.name ?? session?.user?.email ?? "Account";
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || "U";
  const [scrolled, setScrolled] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pendingAnchorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isHome) return;
    const onScroll = () => setScrolled(window.scrollY > window.innerHeight * 0.7);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isHome]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setMobileMenuOpen(false);
      setProfileOpen(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  const scrollToAnchor = useCallback((hash: string) => {
    const id = hash.startsWith("#") ? hash.slice(1) : hash;
    if (!id) return false;
    const element = document.getElementById(id);
    if (!element) return false;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    window.history.replaceState(null, "", `/#${id}`);
    return true;
  }, []);

  const scrollToAnchorWithRetry = useCallback((hash: string, attempts = 12) => {
    let remaining = attempts;
    const tick = () => {
      const didScroll = scrollToAnchor(hash);
      if (didScroll) {
        pendingAnchorRef.current = null;
        return;
      }
      if (remaining <= 0) return;
      remaining -= 1;
      window.requestAnimationFrame(tick);
    };
    tick();
  }, [scrollToAnchor]);

  useEffect(() => {
    if (!isHome) return;
    const target = pendingAnchorRef.current ?? window.location.hash;
    if (!target) return;
    scrollToAnchorWithRetry(target);
  }, [isHome, pathname, scrollToAnchorWithRetry]);

  const handleAnchorClick = useCallback(
    (hash: string, onHandled?: () => void) =>
      (event: React.MouseEvent<HTMLAnchorElement>) => {
        onHandled?.();

        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }

        event.preventDefault();
        pendingAnchorRef.current = hash;

        if (isHome) {
          scrollToAnchorWithRetry(hash);
          return;
        }

        router.push("/");
      },
    [isHome, router, scrollToAnchorWithRetry]
  );

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
          <Image src="/tallei.svg" alt="Tallei Logo" width={88} height={36} style={{ height: "36px", width: "auto" }} />
        </Link>

        {isHome && (
          <div className="site-nav-links">
            <Link
              href="/#how-it-works"
              onClick={handleAnchorClick("#how-it-works")}
              style={{ color: "var(--text-2)", fontSize: "0.95rem", fontWeight: 500 }}
            >
              How it works
            </Link>
            <Link
              href="/#integrations"
              onClick={handleAnchorClick("#integrations")}
              style={{ color: "var(--text-2)", fontSize: "0.95rem", fontWeight: 500 }}
            >
              Integrations
            </Link>
            <Link
              href="/#pricing"
              onClick={handleAnchorClick("#pricing")}
              style={{ color: "var(--text-2)", fontSize: "0.95rem", fontWeight: 500 }}
            >
              Pricing
            </Link>
          </div>
        )}

        <div className="site-nav-actions site-nav-actions-desktop">
          {isLoading ? (
            <div style={{ width: "80px" }} aria-hidden="true" />
          ) : isAuthenticated ? (
            <>
              <Link href="/dashboard" className="landing-btn landing-btn-base landing-btn-nav" style={{background: "black", border: "1px solid black"}}>
                Dashboard
              </Link>
              <div className="site-profile-menu-wrap" style={{ position: "relative" }}>
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
                        borderRadius: "var(--radius-lg)",
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
            <div style={{ display: "flex", gap: "1.5rem", alignItems: "center" }}>
              <Link href="/login" className="landing-btn landing-btn-base" style={{ padding: "0.5rem 1rem", fontSize: "0.95rem", borderRadius: "0" }}>
                Get started
              </Link>
            </div>
          )}
        </div>

        <button
          type="button"
          className="site-mobile-toggle"
          onClick={() => setMobileMenuOpen((value) => !value)}
          aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileMenuOpen}
        >
          {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      <button
        type="button"
        className={`site-mobile-backdrop ${mobileMenuOpen ? "open" : ""}`}
        aria-label="Close mobile menu"
        onClick={() => setMobileMenuOpen(false)}
      />

      <div className={`site-mobile-menu ${mobileMenuOpen ? "open" : ""}`}>
        {isHome && (
          <div className="site-mobile-menu-links">
            <Link href="/#how-it-works" onClick={handleAnchorClick("#how-it-works", () => setMobileMenuOpen(false))}>How it works</Link>
            <Link href="/#integrations" onClick={handleAnchorClick("#integrations", () => setMobileMenuOpen(false))}>Integrations</Link>
            <Link href="/#pricing" onClick={handleAnchorClick("#pricing", () => setMobileMenuOpen(false))}>Pricing</Link>
          </div>
        )}

        {isLoading ? null : isAuthenticated ? (
          <div className="site-mobile-menu-actions">
         <Link
  href="/dashboard"
  className="landing-btn landing-btn-base landing-btn-nav"
  onClick={() => setMobileMenuOpen(false)}
>
  Dashboard
</Link>

            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setMobileMenuOpen(false);
                void signOut({ callbackUrl: "/login" });
              }}
            >
              Log out
            </button>
          </div>
        ) : (
          <div className="site-mobile-menu-actions">
          
            <Link href="/login" className="landing-btn landing-btn-base" onClick={() => setMobileMenuOpen(false)}>
              Get started
            </Link>
          </div>
        )}
      </div>
    </nav>
  );
}
