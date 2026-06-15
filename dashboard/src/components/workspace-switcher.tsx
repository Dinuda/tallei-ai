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
  const [iconUrl, setIconUrl] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createWorkspace({ name: name.trim(), description: description.trim() || null, icon: iconUrl.trim() || null });
      setCreateOpen(false);
      setName("");
      setDescription("");
      setIconUrl("");
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
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-bold text-slate-900 hover:bg-slate-100 transition-colors"
        onClick={() => setOpen((value) => !value)}
      >
        {activeWorkspace?.icon ? (
          <img src={activeWorkspace.icon} alt="" className="size-5 rounded object-cover" />
        ) : (
          <span className="text-slate-400 text-lg leading-none font-medium mt-[1px]" style={{ color: color }}>#</span>
        )}
        <span className="max-w-[140px] truncate">{label}</span>
        {activeWorkspace?.kind === "personal" ? (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Personal</span>
        ) : null}
        <ChevronDown className="size-4 text-slate-400 ml-1" />
      </button>

      {open ? (
        <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-72 rounded-[14px] border border-slate-200/80 bg-white p-1.5 shadow-[0_8px_30px_rgb(0,0,0,0.08)]">
          <div className="px-2.5 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">Workspaces</div>
          <div className="space-y-0.5">
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                className="group flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left transition-colors hover:bg-slate-100/80"
                onClick={() => {
                  void setActiveWorkspace(workspace.id).catch((error) => {
                    console.error(error);
                  });
                  setOpen(false);
                }}
              >
                <div 
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-slate-200/60 bg-white shadow-sm transition-colors group-hover:border-slate-300 overflow-hidden"
                  style={{ color: workspace.color ?? "#94a3b8" }}
                >
                  {workspace.icon ? (
                    <img src={workspace.icon} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="text-lg font-bold leading-none mt-[1px]">#</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-900">{workspace.name}</div>
                  {workspace.kind === "personal" ? (
                    <div className="text-[11px] font-medium text-slate-500">Default personal space</div>
                  ) : null}
                </div>
                {workspace.id === activeWorkspace?.id ? <Check className="size-4 text-emerald-600" /> : null}
              </button>
            ))}
          </div>

          <div className="my-1.5 border-t border-slate-100" />

          <div className="space-y-0.5">
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <button type="button" className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100/80 hover:text-slate-900">
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
                  <Input placeholder="Image URL (optional)" value={iconUrl} onChange={(event) => setIconUrl(event.target.value)} />
                  <Button disabled={saving || !name.trim()} onClick={() => void handleCreate()}>
                    {saving ? "Creating..." : "Create workspace"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            <Link
              href="/dashboard/workspace/settings"
              className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100/80 hover:text-slate-900"
              onClick={() => setOpen(false)}
            >
              <Settings className="size-4" />
              Workspace settings
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
