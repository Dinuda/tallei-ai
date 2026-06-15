"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api-fetch";

type WorkspaceMemory = {
  id: string;
  text: string;
  source: string;
  createdAt: string;
};

export default function WorkspaceMemoryPage() {
  const [memories, setMemories] = useState<WorkspaceMemory[]>([]);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");

  async function load(search = "") {
    const response = await apiFetch(`/api/workspace-memory${search ? `?q=${encodeURIComponent(search)}` : ""}`, { cache: "no-store" });
    const payload = await response.json();
    setMemories(Array.isArray(payload.memories) ? payload.memories as WorkspaceMemory[] : []);
  }

  useEffect(() => { void load(); }, []);

  async function saveMemory() {
    if (!text.trim()) return;
    await apiFetch("/api/workspace-memory", { method: "POST", body: JSON.stringify({ text }) });
    setText("");
    await load(query);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Workspace memory</h1>
        <p className="mt-1 text-sm text-slate-500">Separate from your global Tallei memories.</p>
      </div>
      <div className="flex gap-2">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workspace memory" />
        <Button variant="outline" onClick={() => void load(query)}>Search</Button>
      </div>
      <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
        <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="Add workspace memory..." />
        <Button onClick={() => void saveMemory()}>Save</Button>
      </div>
      <div className="space-y-3">
        {memories.map((memory) => (
          <div key={memory.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{memory.source}</div>
            <p className="text-sm text-slate-800 whitespace-pre-wrap">{memory.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
