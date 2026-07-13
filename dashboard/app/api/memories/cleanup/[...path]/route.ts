import { NextRequest } from "next/server";
// import { auth } from "../../../../../auth";

const SECRET = process.env.INTERNAL_API_SECRET!;
const DEFAULT_BACKEND_TIMEOUT_MS = 120_000;

function parseTimeout(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

function isStreamPath(path: string[]): boolean {
  return path.at(-1) === "stream";
}

function isEmbeddingMapPath(path: string[]): boolean {
  return path.at(-1) === "embedding-map";
}

function resolveTimeoutMs(path: string[], envValue: string | undefined): number {
  if (isEmbeddingMapPath(path)) {
    return parseTimeout(envValue, 180_000);
  }
  return parseTimeout(envValue, DEFAULT_BACKEND_TIMEOUT_MS);
}

async function proxyStream(
  req: NextRequest,
  session: { user: { id: string } },
  path: string[],
  backend: string
): Promise<Response> {
  const target = new URL(`${backend}/api/memories/cleanup/${path.map(encodeURIComponent).join("/")}`);
  req.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  try {
    const res = await fetch(target.toString(), {
      method: "GET",
      headers: {
        "Accept": "text/event-stream",
        "X-Internal-Secret": SECRET,
        "X-User-Id": session.user.id,
      },
      signal: req.signal,
    });

    if (!res.ok || !res.body) {
      const data = await safeJson(res);
      return Response.json(data, { status: res.status });
    }

    return new Response(res.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("[memory-cleanup-proxy] SSE stream failed", {
      path: path.join("/"),
      target: target.toString(),
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    });
    return Response.json(
      { error: "Failed to reach backend stream endpoint" },
      { status: 502 }
    );
  }
}

async function proxy(
  req: NextRequest,
  method: "GET" | "POST",
  { params }: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
  try {
    const session = { user: { id: "1e8787f0-2f95-45ea-aa50-705b630e66e2" } };

    const { path = [] } = (await params) || {};
    const backend = resolveBackendUrl(req);

    if (method === "GET" && isStreamPath(path)) {
      return proxyStream(req, session as { user: { id: string } }, path, backend);
    }

    const target = new URL(`${backend}/api/memories/cleanup/${path.map(encodeURIComponent).join("/")}`);
    req.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));
    const timeoutMs = resolveTimeoutMs(path, process.env.MEMORY_CLEANUP_PROXY_TIMEOUT_MS);

    try {
      const res = await fetchWithTimeout(target.toString(), timeoutMs, {
        method,
        headers: {
          "content-type": "application/json",
          "X-Internal-Secret": SECRET,
          "X-User-Id": session.user.id,
        },
        body: method === "POST" ? JSON.stringify(await req.json().catch(() => ({}))) : undefined,
      });
      const data = await safeJson(res);
      if (!res.ok) {
        console.error("[memory-cleanup-proxy] backend returned error", {
          method,
          path: path.join("/"),
          status: res.status,
          target: target.toString(),
          data,
        });
      }
      return Response.json(data, { status: res.status });
    } catch (error) {
      const isAbort = error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
      const errObj = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error;
      console.error("[memory-cleanup-proxy] backend request failed", {
        method,
        path: path.join("/"),
        target: target.toString(),
        timeoutMs,
        error: errObj,
      });
      return Response.json(
        {
          error: isAbort ? "Timed out contacting backend memory cleanup API" : "Failed to reach backend memory cleanup API",
          debugError: errObj,
          debugTarget: target.toString(),
          debugSecret: SECRET,
        },
        { status: isAbort ? 504 : 502 }
      );
    }
  } catch (outerError) {
    const errObj = outerError instanceof Error
      ? { name: outerError.name, message: outerError.message, stack: outerError.stack }
      : outerError;
    return Response.json({
      error: "Outer proxy error",
      debugOuterError: errObj,
    }, { status: 500 });
  }
}

export async function GET(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, "GET", context);
}

export async function POST(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, "POST", context);
}
