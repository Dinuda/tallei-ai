import { NextRequest } from "next/server";

const BACKEND_TIMEOUT_MS = 60_000;

function resolveBackendUrl(req: NextRequest): string {
  const configured = process.env.BACKEND_URL || process.env.API_PROXY_TARGET || "http://127.0.0.1:3000";
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

function forwardHeader(req: NextRequest, name: string): Record<string, string> {
  const value = req.headers.get(name);
  return value ? { [name]: value } : {};
}

export async function POST(req: NextRequest): Promise<Response> {
  const backend = resolveBackendUrl(req);
  const rawBody = await req.text();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  try {
    const res = await fetch(`${backend}/api/connectors/composio/webhook`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": req.headers.get("content-type") ?? "application/json",
        ...forwardHeader(req, "webhook-id"),
        ...forwardHeader(req, "webhook-timestamp"),
        ...forwardHeader(req, "webhook-signature"),
        ...forwardHeader(req, "x-composio-signature"),
      },
      body: rawBody,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
    return Response.json(
      { error: isAbort ? "Timed out contacting backend composio webhook" : "Failed to reach backend composio webhook" },
      { status: isAbort ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
