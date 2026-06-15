"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api-fetch";
import { useWorkspace } from "@/lib/workspace-context";

export default function WorkspaceSettingsPage() {
  const { activeWorkspace, refresh } = useWorkspace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!activeWorkspace) return;
    setName(activeWorkspace.name);
    setDescription(activeWorkspace.description ?? "");
    setIconUrl(activeWorkspace.icon ?? "");
  }, [activeWorkspace]);

  async function save() {
    if (!activeWorkspace) return;
    setSaving(true);
    try {
      await apiFetch(`/api/workspaces/${activeWorkspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description: description || null, icon: iconUrl || null }),
      });
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!activeWorkspace) return <div className="p-8 text-sm text-slate-500">Loading workspace...</div>;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Workspace settings</h1>
        <p className="mt-1 text-sm text-slate-500">Configure {activeWorkspace.name}</p>
      </div>

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">General</h2>
        <div className="space-y-3">
          <Input value={name} onChange={(event) => setName(event.target.value)} disabled={activeWorkspace.kind === "personal"} placeholder="Workspace name" />
          <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" />
          <div>
            <Input value={iconUrl} onChange={(event) => setIconUrl(event.target.value)} placeholder="Image URL (optional)" />
            {iconUrl && (
              <div className="mt-2 flex items-center gap-3">
                <span className="text-xs text-slate-500">Preview:</span>
                <img src={iconUrl} alt="Preview" className="size-8 rounded-md object-cover border border-slate-200" />
              </div>
            )}
          </div>
        </div>
        <Button onClick={() => void save()} disabled={saving}>{saving ? "Saving..." : "Save changes"}</Button>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Knowledge</h2>
        <p className="text-sm text-slate-600">Manage workspace memory and FAQ collections separately from your global Tallei memories.</p>
        <div className="flex gap-3">
          <Button asChild variant="outline"><Link href="/dashboard/workspace/memory">Workspace memory</Link></Button>
          <Button asChild variant="outline"><Link href="/dashboard/workspace/knowledge">Knowledge bases</Link></Button>
        </div>
      </section>
    </div>
  );
}
