import type { NextConfig } from "next";

// Backend is always local — never exposed to the internet directly.
const BACKEND = (process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000").replace(/\/$/, "");

// The ngrok URL is loaded from NEXTAUTH_URL (set at runtime).
// allowedDevOrigins is derived at build-time, so we read it from an explicit env var.
const NGROK_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.NEXTAUTH_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "";

const nextConfig: NextConfig = {
  // Allow the ngrok host as a trusted dev origin (needed for HMR over ngrok)
  ...(NGROK_URL
    ? { allowedDevOrigins: [NGROK_URL.replace(/^https?:\/\//, "")] }
    : {}),

  async rewrites() {
    return {
      // Ensure MCP OAuth endpoints are proxied before filesystem routes.
      // Without this, /register can be intercepted by the dashboard auth page
      // and redirected to /login, breaking dynamic client registration.
      beforeFiles: [
        {
          source: "/.well-known/:path*",
          destination: `${BACKEND}/.well-known/:path*`,
        },
        {
          source: "/token",
          destination: `${BACKEND}/token`,
        },
        {
          source: "/register",
          destination: `${BACKEND}/register`,
        },
      ],
      afterFiles: [
        // ── Backend API & MCP (proxied transparently) ────────────────────────
        {
          // Keep NextAuth's own /api/auth/* handlers in Next.js.
          // Proxy all other API routes to the backend.
          source:
            "/api/:path((?!auth/(?:signin|signout|session|csrf|providers|callback|error|verify-request|webauthn-options)(?:/|$)).*)",
          destination: `${BACKEND}/api/:path`,
        },
        {
          source: "/mcp/:path*",
          destination: `${BACKEND}/mcp/:path*`,
        },
        {
          source: "/mcp",
          destination: `${BACKEND}/mcp`,
        },
        {
          source: "/health",
          destination: `${BACKEND}/health`,
        },
      ],
      fallback: [],
    };
  },
};

export default nextConfig;
