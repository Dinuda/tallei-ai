"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const HIDDEN_PREFIXES = ["/dashboard", "/login", "/register", "/authorize"];

export function TopNav() {
  const pathname = usePathname() || "";
  const isHidden = HIDDEN_PREFIXES.some(prefix => pathname.startsWith(prefix));
  const isHome = pathname === "/";

  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (!isHome) return;
    const onScroll = () => setScrolled(window.scrollY > window.innerHeight * 0.7);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isHome]);

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
          <Link href="/dashboard/setup" className="btn btn-ghost">Setup</Link>
          <Link href="/dashboard" className="btn btn-ghost">Dashboard</Link>
          <Link href="/login" className="btn btn-primary btn-sm">Sign in</Link>
        </div>
      </div>
    </nav>
  );
}
