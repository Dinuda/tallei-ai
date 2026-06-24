"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function NewLoopPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await apiFetch("/api/loops", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create loop");
      router.push(`/dashboard/loops/${data.loop.id}/builder`);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to create loop");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 p-6">
      <h1 className="text-2xl font-bold">New loop</h1>
      <Input placeholder="Loop name" value={name} onChange={(e) => setName(e.target.value)} />
      <Button onClick={() => void handleCreate()} disabled={saving || !name.trim()}>
        {saving ? "Creating..." : "Continue to builder"}
      </Button>
    </div>
  );
}
