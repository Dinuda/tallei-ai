import { NextRequest } from "next/server";
import { auth } from "../../../../auth";
import { getToken } from "next-auth/jwt";

const SECRET = process.env.INTERNAL_API_SECRET!;
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
  const token = await getToken({ req, secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET });
  return token && typeof token.backendId === "string" ? token.backendId : null;
}

async function proxy(req: NextRequest, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"): Promise<Response> {
  const userId = await resolveBackendUserId(req);
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const path = req.nextUrl.pathname.replace(/^\/api\/workspaces\/?/, "").replace(/^\/+/, "");
  const backend = resolveBackendUrl(req);
  const target = new URL(`${backend}/api/workspaces${path ? `/${path}` : ""}`);
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
    return Response.json({ error: "Failed to reach backend workspaces API" }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(req: NextRequest) { return proxy(req, "GET"); }
export async function POST(req: NextRequest) { return proxy(req, "POST"); }
export async function PATCH(req: NextRequest) { return proxy(req, "PATCH"); }
export async function DELETE(req: NextRequest) { return proxy(req, "DELETE"); }
