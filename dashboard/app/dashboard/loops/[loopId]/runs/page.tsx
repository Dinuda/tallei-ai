"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";

type LoopRun = {
  id: string;
  status: string;
  trigger_kind: string;
  started_at: string;
  finished_at: string | null;
};

export default function LoopRunsPage() {
  const params = useParams<{ loopId: string }>();
  const loopId = params.loopId;
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const res = await apiFetch(`/api/loops/${loopId}/runs`);
        const data = await res.json();
        if (res.ok) setRuns(data.runs ?? []);
      } finally {
        setLoading(false);
      }
    })();
  }, [loopId]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#182506]">Loop runs</h1>
        <Button variant="outline" asChild>
          <Link href={`/dashboard/loops/${loopId}/builder`}>Back to builder</Link>
        </Button>
      </div>
      {loading ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
      {!loading && runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="space-y-2">
          {runs.map((run) => (
            <li key={run.id}>
              <Link
                href={`/dashboard/loops/${loopId}/runs/${run.id}`}
                className="flex items-center justify-between rounded-lg border border-[#e4f5c6] bg-white px-4 py-3 hover:bg-[#f8fdf2]"
              >
                <span className="font-mono text-sm">{run.id.slice(0, 8)}…</span>
                <span className="text-xs uppercase tracking-wide text-[#7a9a4a]">{run.status}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
