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
    // Keep configured value.
  }

  return configured.replace(/\/$/, "");
}

function backendHeaders(userId: string) {
  return {
    "X-Internal-Secret": SECRET,
    "X-User-Id": userId,
  };
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

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = req.nextUrl.searchParams.get("q") ?? "";
  const limit = req.nextUrl.searchParams.get("limit") ?? "5";
  const graphDepth = req.nextUrl.searchParams.get("graph_depth") ?? "1";
  const backend = resolveBackendUrl(req);

  try {
    const target =
      `${backend}/api/memories/recall-v2` +
      `?q=${encodeURIComponent(q)}` +
      `&limit=${encodeURIComponent(limit)}` +
      `&graph_depth=${encodeURIComponent(graphDepth)}`;
    const res = await fetchWithTimeout(target, {
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
          ? "Timed out contacting backend /api/memories/recall-v2"
          : "Failed to reach backend /api/memories/recall-v2",
      },
      { status: isAbort ? 504 : 502 }
    );
  }
}
