import { NextRequest, NextResponse } from "next/server";

function hasSessionCookie(req: NextRequest): boolean {
  return Boolean(
    req.cookies.get("__Secure-authjs.session-token")?.value ||
    req.cookies.get("authjs.session-token")?.value
  );
}

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isAuthenticated = hasSessionCookie(req);

  if (pathname.startsWith("/dashboard") && !isAuthenticated) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
