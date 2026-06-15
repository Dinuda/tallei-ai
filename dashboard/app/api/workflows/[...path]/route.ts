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
      const fallback = process.env.API_PROXY_TARGET || "http://127.0.0.1:3000";
      return fallback.replace(/\/$/, "");
    }
  } catch {
    // ignore
  }
  return configured.replace(/\/$/, "");
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return { error: "Backend returned invalid JSON" };
  }
}

async function resolveBackendUserId(req: NextRequest): Promise<string | null> {
  const session = await auth();
  if (session?.user?.id) return session.user.id;

  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  });
  const backendId = token && typeof token.backendId === "string" ? token.backendId : null;
  return backendId;
}

async function proxyLoopApproval(req: NextRequest): Promise<Response> {
  const backend = resolveBackendUrl(req);
  const path = req.nextUrl.pathname.replace(/^\/api\/workflows\/?/, "").replace(/^\/+/, "");
  const target = new URL(`${backend}/api/workflows/${path}`);
  req.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  try {
    const res = await fetchWithTimeout(target.toString(), {
      method: "GET",
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (location && res.status >= 300 && res.status < 400) {
      return Response.redirect(location, res.status);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = await safeJson(res);
      return Response.json(data, { status: res.status });
    }
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": contentType || "text/plain" },
    });
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
    return Response.json({ error: isAbort ? "Timed out contacting backend workflows API" : "Failed to reach backend workflows API" }, { status: isAbort ? 504 : 502 });
  }
}

async function proxy(req: NextRequest, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"): Promise<Response> {
  const path = req.nextUrl.pathname.replace(/^\/api\/workflows\/?/, "").replace(/^\/+/, "");
  if (method === "GET" && path.startsWith("loops/approvals/")) {
    return proxyLoopApproval(req);
  }

  const userId = await resolveBackendUserId(req);
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const backend = resolveBackendUrl(req);
  const target = new URL(`${backend}/api/workflows${path ? `/${path}` : ""}`);
  req.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  const headers: Record<string, string> = {
        "content-type": "application/json",
        "X-Internal-Secret": SECRET,
        "X-User-Id": userId,
      };
  const workspaceId = req.headers.get("x-workspace-id");
  if (workspaceId) headers["X-Workspace-Id"] = workspaceId;

  const isStreamingChat = method === "POST" && /\/run\/chat$/.test(path);

  try {
    const body = method === "GET" ? undefined : isStreamingChat ? await req.text() : JSON.stringify(await req.json().catch(() => ({})));
    const res = isStreamingChat ? await fetch(target.toString(), {
      method,
      headers,
      body,
    }) : await fetchWithTimeout(target.toString(), {
      method,
      headers,
      body,
    });
    if (isStreamingChat) {
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }
    const data = await safeJson(res);
    return Response.json(data, { status: res.status });
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
    return Response.json({ error: isAbort ? "Timed out contacting backend workflows API" : "Failed to reach backend workflows API" }, { status: isAbort ? 504 : 502 });
  }
}

export async function GET(req: NextRequest) {
  return proxy(req, "GET");
}

export async function POST(req: NextRequest) {
  return proxy(req, "POST");
}

export async function PUT(req: NextRequest) {
  return proxy(req, "PUT");
}

export async function PATCH(req: NextRequest) {
  return proxy(req, "PATCH");
}

export async function DELETE(req: NextRequest) {
  return proxy(req, "DELETE");
}
