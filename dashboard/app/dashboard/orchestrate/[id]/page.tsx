"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

export default function OrchestrateSessionRedirectPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id ?? "";

  useEffect(() => {
    if (!id) {
      router.replace("/dashboard/tasks");
      return;
    }

    let cancelled = false;

    async function resolveSession() {
      try {
        const res = await fetch(`/api/tasks/orchestrations/${id}`, { cache: "no-store" });
        const body = await res.json();
        if (!cancelled && res.ok && typeof body?.collabTaskId === "string" && body.collabTaskId) {
          router.replace(`/dashboard/tasks/${body.collabTaskId}`);
          return;
        }
      } catch {
        // Fall through to the task list. Planning now lives in the provider chats, not a dashboard page.
      }
      if (!cancelled) router.replace("/dashboard/tasks");
    }

    void resolveSession();
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  return null;
}
