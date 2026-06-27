"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { deleteLoop } from "@/lib/loops-api";
import { useWorkspace } from "@/lib/workspace-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const STARTERS = [
  { id: "research_digest", title: "Research Digest", description: "Search the web, summarize findings, and deliver a daily digest." },
  { id: "newsletter_loop", title: "Newsletter Loop", description: "Curate AI news and send weekly newsletters to subscribers." },
  { id: "lead_scoring", title: "Lead Scoring Loop", description: "Score incoming leads and notify sales when a hot lead arrives." },
  { id: "support_auto_reply", title: "Support Auto-Reply", description: "Classify tickets and draft replies for review." },
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
  const router = useRouter();
  const { activeWorkspace } = useWorkspace();
  const [loops, setLoops] = useState<LoopSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
      router.push(`/dashboard/loops/${data.loop.id}/conductor`);
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : "Failed to create loop");
    } finally {
      setCreating(null);
    }
  }

  async function handleDeleteLoop(loop: LoopSummary) {
    if (!window.confirm(`Delete "${loop.name}"? This removes the loop and stops any schedules.`)) {
      return;
    }
    setDeletingId(loop.id);
    try {
      await deleteLoop(loop.id);
      setLoops((current) => current.filter((entry) => entry.id !== loop.id));
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to delete loop");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--ed-text)]">Loops</h1>
          <p className="text-sm text-[var(--ed-text-2)]">Describe what you want automated. Tallei builds, compiles, and runs it.</p>
        </div>
        <Button asChild>
          <Link href="/dashboard/loops/new">
            <Plus className="mr-2 size-4" />
            New loop
          </Link>
        </Button>
      </div>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-[var(--ed-text)]">What would you like to automate?</h2>
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
        <h2 className="mb-4 text-lg font-semibold text-[var(--ed-text)]">Your loops</h2>
        {loading ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
        {!loading && loops.length === 0 ? (
          <p className="text-sm text-muted-foreground">No loops yet. Pick a starter above.</p>
        ) : (
          <ul className="space-y-2">
            {loops.map((loop) => (
              <li
                className="flex items-center gap-2 rounded-lg border border-[var(--ed-border-light)] bg-white pr-2 hover:bg-[var(--ed-surface-alt)]"
                key={loop.id}
              >
                <Link
                  className="flex min-w-0 flex-1 items-center justify-between px-4 py-3"
                  href={`/dashboard/loops/${loop.id}/conductor`}
                >
                  <span className="truncate font-medium text-[var(--ed-text)]">{loop.name}</span>
                  <span className="ml-3 shrink-0 text-xs uppercase tracking-wide text-[var(--ed-text-3)]">{loop.status}</span>
                </Link>
                <Button
                  aria-label={`Delete ${loop.name}`}
                  className="shrink-0 text-[var(--ed-text-3)] hover:bg-red-50 hover:text-red-600"
                  disabled={deletingId === loop.id}
                  onClick={() => void handleDeleteLoop(loop)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
