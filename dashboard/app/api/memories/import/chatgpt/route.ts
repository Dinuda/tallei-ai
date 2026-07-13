import { NextRequest } from "next/server";
import { auth } from "../../../../../auth";

const SECRET = process.env.INTERNAL_API_SECRET!;
const BACKEND_TIMEOUT_MS = (() => {
  const raw = process.env.MEMORY_IMPORT_BACKEND_TIMEOUT_MS;
  if (!raw) return 15 * 60_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 15 * 60_000;
  return parsed;
})();

export const maxDuration = 900;

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

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  const backend = resolveBackendUrl(req);

  try {
    let body: BodyInit;
    const headers: Record<string, string> = {
      "X-Internal-Secret": SECRET,
      "X-User-Id": session.user.id,
    };

    if (/multipart\/form-data/i.test(contentType)) {
      headers["Content-Type"] = contentType;
      body = req.body ?? "";
    } else {
      const jsonBody = await req.json().catch(() => ({}));
      body = JSON.stringify(jsonBody);
      headers["Content-Type"] = "application/json";
    }

    const fetchInit: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers,
      body,
    };
    if (/multipart\/form-data/i.test(contentType)) {
      fetchInit.duplex = "half";
    }

    const res = await fetchWithTimeout(`${backend}/api/memories/import/chatgpt`, fetchInit);
    const data = await safeJson(res);
    return Response.json(data, { status: res.status });
  } catch (error) {
    const isAbort =
      error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
    return Response.json(
      {
        error: isAbort
          ? "Timed out contacting backend /api/memories/import/chatgpt"
          : "Failed to reach backend /api/memories/import/chatgpt",
      },
      { status: isAbort ? 504 : 502 }
    );
  }
}
