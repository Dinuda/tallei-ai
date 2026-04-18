import { NextRequest, NextResponse } from "next/server";
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

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const backend = resolveBackendUrl(req);

  try {
    const url = new URL(`${backend}/api/billing/portal`);
    
    const res = await fetch(url.toString(), {
      redirect: "manual", // We want to capture the 302 redirect and forward it
      headers: {
        "X-Internal-Secret": SECRET,
        "X-User-Id": session.user.id,
      },
    });
    
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        return NextResponse.redirect(location);
      }
    }
    
    // If not a redirect, return the response JSON
    try {
      const data = await res.json();
      return NextResponse.json(data, { status: res.status });
    } catch {
      return new NextResponse(await res.text(), { status: res.status });
    }
  } catch (error) {
    return NextResponse.json({ error: "Failed to reach backend" }, { status: 502 });
  }
}
