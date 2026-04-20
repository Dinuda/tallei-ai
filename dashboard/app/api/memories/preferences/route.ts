import { NextRequest } from "next/server";
import { auth } from "../../../../auth";

const SECRET = process.env.INTERNAL_API_SECRET!;
const BACKEND_TIMEOUT_MS = 60_000;

function resolveBackendUrl(req?: NextRequest): string {
  const configured =
    process.env.BACKEND_URL ||
    process.env.API_PROXY_TARGET ||
    "http://127.0.0.1:3000";

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

function backendHeaders(userId: string, extra?: Record<string, string>) {
  return {
    "X-Internal-Secret": SECRET,
    "X-User-Id": userId,
    ...extra,
  };
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
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

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const backend = resolveBackendUrl(req);

  try {
    const res = await fetchWithTimeout(`${backend}/api/memories/preferences`, {
      headers: backendHeaders(session.user.id),
    });
    const data = await safeJson(res);
    return Response.json(data, { status: res.status });
  } catch (error) {
    const isAbort =
      error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
    return Response.json(
      {
        error: isAbort
          ? "Timed out contacting backend /api/memories/preferences"
          : "Failed to reach backend /api/memories/preferences",
      },
      { status: isAbort ? 504 : 502 }
    );
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const backend = resolveBackendUrl(req);

  try {
    const res = await fetchWithTimeout(`${backend}/api/memories/preferences`, {
      method: "POST",
      headers: backendHeaders(session.user.id, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const data = await safeJson(res);
    return Response.json(data, { status: res.status });
  } catch (error) {
    const isAbort =
      error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
    return Response.json(
      {
        error: isAbort
          ? "Timed out contacting backend /api/memories/preferences"
          : "Failed to reach backend /api/memories/preferences",
      },
      { status: isAbort ? 504 : 502 }
    );
  }
}
