import { NextRequest } from "next/server";
import { auth } from "../../../auth";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3000";
const SECRET = process.env.INTERNAL_API_SECRET!;

function backendHeaders(userId: string) {
  return {
    "X-Internal-Secret": SECRET,
    "X-User-Id": userId,
  };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const search = req.nextUrl.searchParams;
  const limit = search.get("limit") || "50";

  const res = await fetch(`${BACKEND}/api/mcp/events?limit=${encodeURIComponent(limit)}`, {
    headers: backendHeaders(session.user.id),
  });
  const data = await res.json();
  return Response.json(data, { status: res.status });
}
