import { apiFetch } from "@/lib/api-fetch";

export async function deleteLoop(loopId: string): Promise<void> {
  const res = await apiFetch(`/api/loops/${loopId}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Failed to delete loop");
  }
}
