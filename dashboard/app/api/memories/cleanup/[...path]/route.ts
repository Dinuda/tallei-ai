import { NextRequest } from "next/server";
import { auth } from "../../../../../auth";

const SECRET = process.env.INTERNAL_API_SECRET!;
const BACKEND_TIMEOUT_MS = 120_000;

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
    // Use configured value as-is if URL parsing fails.
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

async function proxy(
  req: NextRequest,
  method: "GET" | "POST",
  { params }: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path = [] } = await params;
  const backend = resolveBackendUrl(req);
  const target = new URL(`${backend}/api/memories/cleanup/${path.map(encodeURIComponent).join("/")}`);
  req.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  try {
    const res = await fetchWithTimeout(target.toString(), {
      method,
      headers: {
        "content-type": "application/json",
        "X-Internal-Secret": SECRET,
        "X-User-Id": session.user.id,
      },
      body: method === "POST" ? JSON.stringify(await req.json().catch(() => ({}))) : undefined,
    });
    const data = await safeJson(res);
    return Response.json(data, { status: res.status });
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
    return Response.json(
      { error: isAbort ? "Timed out contacting backend memory cleanup API" : "Failed to reach backend memory cleanup API" },
      { status: isAbort ? 504 : 502 }
    );
  }
}

export async function GET(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, "GET", context);
}

export async function POST(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, "POST", context);
}

