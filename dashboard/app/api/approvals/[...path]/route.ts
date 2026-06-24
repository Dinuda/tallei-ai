import { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

import { auth } from "../../../../auth";

const SECRET = process.env.INTERNAL_API_SECRET;
const BACKEND_TIMEOUT_MS = 60_000;

function resolveBackendUrl(req?: NextRequest): string {
  const configured = process.env.BACKEND_URL || process.env.API_PROXY_TARGET || "http://127.0.0.1:3000";
  if (!req) return configured.replace(/\/$/, "");
  try {
    const backendOrigin = new URL(configured).origin;
    if (backendOrigin === req.nextUrl.origin) {
      return (process.env.API_PROXY_TARGET || "http://127.0.0.1:3000").replace(/\/$/, "");
    }
  } catch {
    // ignore
  }
  return configured.replace(/\/$/, "");
}

async function resolveBackendUserId(req: NextRequest): Promise<string | null> {
  const session = await auth();
  if (session?.user?.id) return session.user.id;
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  });
  return token && typeof token.backendId === "string" ? token.backendId : null;
}

async function proxy(req: NextRequest, method: "GET" | "POST"): Promise<Response> {
  if (!SECRET) {
    return Response.json(
      { error: "Dashboard misconfigured: INTERNAL_API_SECRET is not set." },
      { status: 500 },
    );
  }

  const userId = await resolveBackendUserId(req);
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const backend = resolveBackendUrl(req);
  const path = req.nextUrl.pathname.replace(/^\/api\/approvals\/?/, "").replace(/^\/+/, "");
  const target = new URL(`${backend}/api/approvals${path ? `/${path}` : ""}`);
  req.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Internal-Secret": SECRET,
    "X-User-Id": userId,
  };
  const workspaceId = req.headers.get("x-workspace-id");
  if (workspaceId) headers["X-Workspace-Id"] = workspaceId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  try {
    const res = await fetch(target.toString(), {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(await req.json().catch(() => ({}))),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return Response.json(data, { status: res.status });
  } catch {
    return Response.json({ error: "Failed to reach backend approvals API" }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(req: NextRequest) {
  return proxy(req, "GET");
}

export async function POST(req: NextRequest) {
  return proxy(req, "POST");
}

export const dynamic = "force-dynamic";
