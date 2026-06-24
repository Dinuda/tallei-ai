"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { useWorkspace } from "@/lib/workspace-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const STARTERS = [
  { id: "research_digest", title: "Research Digest", description: "Search the web, summarize findings, and deliver a daily digest." },
  { id: "newsletter_loop", title: "Newsletter Loop", description: "Curate AI news and send weekly newsletters to subscribers." },
  { id: "lead_scoring", title: "Lead Scoring Loop", description: "Score incoming leads and notify sales when a hot lead arrives." },
  { id: "support_auto_reply", title: "Support Auto-Reply", description: "Auto-classify support tickets and send context-aware replies." },
  { id: "smart_alerts", title: "Smart Alerts", description: "Monitor data and notify when thresholds break." },
  { id: "crm_sync", title: "CRM Sync", description: "Keep contacts in sync between Notion, Airtable, and your CRM." },
] as const;

type LoopSummary = {
  id: string;
  name: string;
  status: string;
  workspaceId: string;
  updatedAt: string;
};

export default function LoopsPage() {
  const { activeWorkspace } = useWorkspace();
  const [loops, setLoops] = useState<LoopSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    if (!activeWorkspace?.id) return;
    void (async () => {
      setLoading(true);
      try {
        const res = await apiFetch("/api/loops");
        const data = await res.json();
        if (res.ok) setLoops(data.loops ?? []);
      } finally {
        setLoading(false);
      }
    })();
  }, [activeWorkspace?.id]);

  async function createFromTemplate(templateId: string, title: string) {
    setCreating(templateId);
    try {
      const res = await apiFetch("/api/loops", {
        method: "POST",
        body: JSON.stringify({ name: title, templateId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create loop");
      window.location.href = `/dashboard/loops/${data.loop.id}/builder`;
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : "Failed to create loop");
    } finally {
      setCreating(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#182506]">Loops</h1>
          <p className="text-sm text-[#3d5c18]">Describe what you want automated. Tallei builds, compiles, and runs it.</p>
        </div>
        <Button asChild>
          <Link href="/dashboard/loops/new">
            <Plus className="mr-2 size-4" />
            New loop
          </Link>
        </Button>
      </div>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-[#182506]">What would you like to automate?</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {STARTERS.map((starter) => (
            <Card key={starter.id} className="cursor-pointer transition hover:shadow-md" onClick={() => void createFromTemplate(starter.id, starter.title)}>
              <CardHeader>
                <CardTitle className="text-base">{starter.title}</CardTitle>
                <CardDescription>{starter.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button size="sm" disabled={creating === starter.id} onClick={(e) => { e.stopPropagation(); void createFromTemplate(starter.id, starter.title); }}>
                  {creating === starter.id ? "Creating..." : "Start"}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-[#182506]">Your loops</h2>
        {loading ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
        {!loading && loops.length === 0 ? (
          <p className="text-sm text-muted-foreground">No loops yet. Pick a starter above.</p>
        ) : (
          <ul className="space-y-2">
            {loops.map((loop) => (
              <li key={loop.id}>
                <Link href={`/dashboard/loops/${loop.id}/builder`} className="flex items-center justify-between rounded-lg border border-[#e4f5c6] bg-white px-4 py-3 hover:bg-[#f8fdf2]">
                  <span className="font-medium">{loop.name}</span>
                  <span className="text-xs uppercase tracking-wide text-[#7a9a4a]">{loop.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
