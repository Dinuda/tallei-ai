import { NextRequest } from "next/server";
import { auth } from "../../../../auth";

const SECRET = process.env.INTERNAL_API_SECRET!;

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
    // Use configured value as-is.
  }

  return configured.replace(/\/$/, "");
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const backend = resolveBackendUrl(req);

  try {
    const res = await fetch(`${backend}/api/billing/resume`, {
      method: "POST",
      headers: {
        "X-Internal-Secret": SECRET,
        "X-User-Id": session.user.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const data = await res.json().catch(() => ({ error: "Invalid backend response" }));
    return Response.json(data, { status: res.status });
  } catch {
    return Response.json({ error: "Failed to reach backend" }, { status: 502 });
  }
}
