import { NextRequest } from "next/server";
import { auth } from "../../../auth";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3000";
const SECRET = process.env.INTERNAL_API_SECRET!;

function backendHeaders(userId: string, extra?: Record<string, string>) {
  return {
    "X-Internal-Secret": SECRET,
    "X-User-Id": userId,
    ...extra,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = await fetch(`${BACKEND}/api/keys`, {
    headers: backendHeaders(session.user.id),
  });
  const data = await res.json();
  return Response.json(data, { status: res.status });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const res = await fetch(`${BACKEND}/api/keys`, {
    method: "POST",
    headers: backendHeaders(session.user.id, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return Response.json(data, { status: res.status });
}
