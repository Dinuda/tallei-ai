import { NextRequest } from "next/server";
import { auth } from "../../../../auth";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3000";
const SECRET = process.env.INTERNAL_API_SECRET!;

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const res = await fetch(`${BACKEND}/api/keys/${id}`, {
    method: "DELETE",
    headers: {
      "X-Internal-Secret": SECRET,
      "X-User-Id": session.user.id,
    },
  });
  const data = await res.json();
  return Response.json(data, { status: res.status });
}
