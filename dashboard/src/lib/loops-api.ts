import { apiFetch } from "@/lib/api-fetch";

export async function deleteLoop(loopId: string): Promise<void> {
  const res = await apiFetch(`/api/loops/${loopId}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Failed to delete loop");
  }
}

export async function renameLoop(loopId: string, name: string): Promise<{ id: string; name: string }> {
  const res = await apiFetch(`/api/loops/${loopId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Failed to rename loop");
  }
  return data.loop;
}
