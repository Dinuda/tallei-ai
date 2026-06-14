import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET,
    INTERNAL_API_SECRET_TYPE: typeof process.env.INTERNAL_API_SECRET,
    API_PROXY_TARGET: process.env.API_PROXY_TARGET,
    BACKEND_URL: process.env.BACKEND_URL,
    NODE_ENV: process.env.NODE_ENV,
  });
}
