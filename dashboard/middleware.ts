import { auth } from "./auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Protect /dashboard routes
  if (pathname.startsWith("/dashboard") && !req.auth) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // If already logged in, redirect / and /login to dashboard
  if ((pathname === "/" || pathname === "/login") && req.auth) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }
});

export const config = {
  matcher: ["/dashboard/:path*", "/login", "/"],
};
