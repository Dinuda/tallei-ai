"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

type Approval = {
  id: string;
  tool_id: string;
  proposed_action: unknown;
  status: string;
  created_at: string;
};

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedArgsJson, setEditedArgsJson] = useState("{}");

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch("/api/approvals?status=pending");
      const data = await res.json();
      if (res.ok) setApprovals(data.approvals ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function startEdit(approval: Approval) {
    setEditingId(approval.id);
    const proposed = approval.proposed_action;
    setEditedArgsJson(
      JSON.stringify(
        proposed && typeof proposed === "object" && "args" in (proposed as object)
          ? (proposed as { args: unknown }).args
          : proposed,
        null,
        2,
      ),
    );
  }

  async function decide(approvalId: string, decision: "approve" | "reject" | "edit") {
    let editedArgs: Record<string, unknown> | undefined;
    if (decision === "edit") {
      try {
        editedArgs = JSON.parse(editedArgsJson) as Record<string, unknown>;
      } catch {
        alert("Edited args must be valid JSON");
        return;
      }
    }
    const res = await apiFetch(`/api/approvals/${approvalId}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, editedArgs }),
    });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error ?? "Failed");
      return;
    }
    setEditingId(null);
    await load();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-2xl font-bold text-[#182506]">Approval inbox</h1>
      {loading ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
      {!loading && approvals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pending approvals.</p>
      ) : (
        <div className="space-y-3">
          {approvals.map((approval) => (
            <Card key={approval.id}>
              <CardHeader>
                <CardTitle className="text-base">{approval.tool_id}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs">
                  {JSON.stringify(approval.proposed_action, null, 2)}
                </pre>
                {editingId === approval.id ? (
                  <Textarea
                    className="min-h-[120px] font-mono text-xs"
                    value={editedArgsJson}
                    onChange={(e) => setEditedArgsJson(e.target.value)}
                  />
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void decide(approval.id, "approve")}>Approve</Button>
                  <Button size="sm" variant="outline" onClick={() => void decide(approval.id, "reject")}>Reject</Button>
                  {editingId === approval.id ? (
                    <Button size="sm" variant="secondary" onClick={() => void decide(approval.id, "edit")}>Save edit &amp; approve</Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => startEdit(approval)}>Edit</Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
