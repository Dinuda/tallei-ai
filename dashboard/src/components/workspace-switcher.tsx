"use client";

import { useState } from "react";
import { Check, ChevronDown, Plus, Settings } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/lib/workspace-context";

export function WorkspaceSwitcher() {
  const { workspaces, activeWorkspace, setActiveWorkspace, createWorkspace, loading } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createWorkspace({ name: name.trim(), description: description.trim() || null });
      setCreateOpen(false);
      setName("");
      setDescription("");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  const label = activeWorkspace?.name ?? (loading ? "Loading..." : "Workspace");
  const color = activeWorkspace?.color ?? "#6366f1";

  return (
    <div className="relative">
      <button
        type="button"
        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex size-6 items-center justify-center rounded-md text-[11px] font-bold text-white" style={{ backgroundColor: color }}>
          {label.slice(0, 1).toUpperCase()}
        </span>
        <span className="max-w-[140px] truncate">{label}</span>
        {activeWorkspace?.kind === "personal" ? (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Personal</span>
        ) : null}
        <ChevronDown className="size-4 text-slate-400" />
      </button>

      {open ? (
        <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-72 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Workspaces</div>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-slate-50"
              onClick={() => {
                void setActiveWorkspace(workspace.id).catch((error) => {
                  console.error(error);
                });
                setOpen(false);
              }}
            >
              <span className="flex size-7 items-center justify-center rounded-md text-xs font-bold text-white" style={{ backgroundColor: workspace.color ?? "#6366f1" }}>
                {workspace.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-900">{workspace.name}</div>
                {workspace.kind === "personal" ? (
                  <div className="text-[11px] text-slate-500">Default personal space</div>
                ) : null}
              </div>
              {workspace.id === activeWorkspace?.id ? <Check className="size-4 text-emerald-600" /> : null}
            </button>
          ))}

          <div className="my-2 border-t border-slate-100" />

          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
                <Plus className="size-4" />
                Create workspace
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create workspace</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <Input placeholder="Workspace name" value={name} onChange={(event) => setName(event.target.value)} />
                <Input placeholder="Description (optional)" value={description} onChange={(event) => setDescription(event.target.value)} />
                <Button disabled={saving || !name.trim()} onClick={() => void handleCreate()}>
                  {saving ? "Creating..." : "Create workspace"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          <Link
            href="/dashboard/workspace/settings"
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-slate-700 hover:bg-slate-50"
            onClick={() => setOpen(false)}
          >
            <Settings className="size-4" />
            Workspace settings
          </Link>
        </div>
      ) : null}
    </div>
  );
}
