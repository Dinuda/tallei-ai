"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const HIDDEN_PREFIXES = ["/dashboard", "/login", "/register", "/authorize"];

export function TopNav() {
  const pathname = usePathname() || "";
  const isHidden = HIDDEN_PREFIXES.some(prefix => pathname.startsWith(prefix));

  if (isHidden) return null;

  return (
    <nav className="site-navbar" aria-label="Primary">
      <div className="container site-nav-inner">
        <Link href="/" className="site-logo">
          <span className="logo-mark">T</span>
          Tallei
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
