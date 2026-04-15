import type { NextConfig } from "next";

const defaultBackend =
  process.env.NODE_ENV === "production" ? "https://api.tallei.com" : "http://127.0.0.1:3000";
const BACKEND = (
  process.env.API_PROXY_TARGET ??
  process.env.BACKEND_URL ??
  defaultBackend
).replace(/\/$/, "");

const NGROK_ORIGIN =
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.NEXTAUTH_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "";

function toAllowedDevOrigin(value: string): string {
  try {
    // Next dev host allow-list expects host[:port], not full URL.
    return new URL(value).host;
  } catch {
    return value.replace(/^https?:\/\//, "");
  }
}

const allowedDevOrigins = Array.from(new Set([
  "localhost:3001",
  "127.0.0.1:3001",
  NGROK_ORIGIN ? toAllowedDevOrigin(NGROK_ORIGIN) : "",
].filter(Boolean)));

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins,

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
