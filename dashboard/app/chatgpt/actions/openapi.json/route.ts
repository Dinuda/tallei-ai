import { NextRequest } from "next/server";

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

export async function GET(req: NextRequest) {
  const backend = resolveBackendUrl(req);

  try {
    const upstream = await fetch(`${backend}/api/chatgpt/actions/openapi.json`, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
        "cache-control": upstream.headers.get("cache-control") ?? "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "Failed to reach backend /api/chatgpt/actions/openapi.json" },
      { status: 502 }
    );
  }
}
