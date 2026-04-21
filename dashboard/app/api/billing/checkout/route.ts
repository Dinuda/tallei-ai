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

function resolveRedirectUrl(
  backend: string,
  response: Response
): string | null {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) return null;

    try {
      return new URL(location, backend).toString();
    } catch {
      return location;
    }
  }

  if (response.redirected && response.url) {
    return response.url;
  }

  return null;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const backend = resolveBackendUrl(req);
  const plan = req.nextUrl.searchParams.get("plan");

  try {
    const url = new URL(`${backend}/api/billing/checkout`);
    if (plan) url.searchParams.set("plan", plan);
    
    const res = await fetch(url.toString(), {
      redirect: "manual", // We want to capture the 302 redirect and forward it
      headers: {
        "X-Internal-Secret": SECRET,
        "X-User-Id": session.user.id,
      },
    });

    const redirectUrl = resolveRedirectUrl(backend, res);
    if (redirectUrl) {
      return NextResponse.redirect(redirectUrl, { status: 302 });
    }

    // If not a redirect, return the response JSON
    try {
      const data = (await res.json()) as { url?: string; checkoutUrl?: string };
      const bodyUrl = data.url ?? data.checkoutUrl;
      if (bodyUrl) {
        return NextResponse.redirect(bodyUrl, { status: 302 });
      }
      return NextResponse.json(data, { status: res.status });
    } catch {
      return new NextResponse(await res.text(), { status: res.status });
    }
  } catch {
    return NextResponse.json({ error: "Failed to reach backend" }, { status: 502 });
  }
}
