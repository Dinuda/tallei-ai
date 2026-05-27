"use client";

import Link from "next/link";
import { AlertCircle, GripVertical, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type RosterAgent = {
  id: string;
  name: string;
  task: string;
  tools: Array<{ ref: string; config?: Record<string, unknown> }>;
};

export type CatalogTool = {
  ref: string;
  label: string;
  description: string;
  provider: "internal" | "composio";
  toolkit: string | null;
  requiresConnector: boolean;
  requiresApproval: boolean;
};

export type ValidationIssue = {
  ref: string;
  code: string;
  message: string;
};

function slugId(name: string, index: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return slug || `agent_${index + 1}`;
}

export function StrategyRosterEditor({
  roster,
  toolCatalog,
  validationIssues,
  editable,
  busy,
  onChange,
  onSave,
}: {
  roster: RosterAgent[];
  toolCatalog: CatalogTool[];
  validationIssues: ValidationIssue[];
  editable: boolean;
  busy?: boolean;
  onChange: (next: RosterAgent[]) => void;
  onSave: (next: RosterAgent[]) => Promise<void>;
}) {
  function updateAgent(index: number, patch: Partial<RosterAgent>) {
    const next = roster.map((agent, i) => {
      if (i !== index) return agent;
      const merged = { ...agent, ...patch };
      if (patch.name && !patch.id) {
        merged.id = slugId(merged.name, index);
      }
      return merged;
    });
    onChange(next);
  }

  function toggleTool(agentIndex: number, ref: string) {
    const agent = roster[agentIndex];
    if (!agent) return;
    const hasTool = agent.tools.some((tool) => tool.ref === ref);
    const tools = hasTool
      ? agent.tools.filter((tool) => tool.ref !== ref)
      : [...agent.tools, { ref }];
    updateAgent(agentIndex, { tools });
  }

  function addAgent() {
    onChange([
      ...roster,
      {
        id: `agent_${roster.length + 1}`,
        name: "Specialist",
        task: "Describe this agent's task for the run.",
        tools: [{ ref: "internal.llm_only" }],
      },
    ]);
  }

  function removeAgent(index: number) {
    onChange(roster.filter((_, i) => i !== index));
  }

  const issuesByRef = new Map(validationIssues.map((issue) => [issue.ref, issue]));

  return (
    <Card className="border-[var(--border-light)] bg-white shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Agent roster</CardTitle>
        <CardDescription>
          CEO proposed these specialists for this run. Edit roles and tools before starting execution.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {validationIssues.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <AlertCircle className="size-3.5" />
              Connector or tool warnings
            </div>
            <ul className="space-y-1">
              {validationIssues.map((issue) => (
                <li key={`${issue.ref}-${issue.code}`}>
                  {issue.message}
                  {issue.code === "connector_missing" && (
                    <>
                      {" "}
                      <Link href="/dashboard/setup" className="underline">Connect in setup</Link>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {roster.map((agent, index) => (
          <div key={`${agent.id}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <div className="mb-3 flex items-start gap-2">
              <GripVertical className="mt-2 size-4 shrink-0 text-slate-300" />
              <div className="grid flex-1 gap-2">
                <Input
                  value={agent.name}
                  disabled={!editable || busy}
                  onChange={(e) => updateAgent(index, { name: e.target.value })}
                  placeholder="Agent name"
                />
                <Textarea
                  value={agent.task}
                  disabled={!editable || busy}
                  onChange={(e) => updateAgent(index, { task: e.target.value })}
                  placeholder="What should this agent do?"
                  rows={2}
                />
              </div>
              {editable && roster.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  onClick={() => removeAgent(index)}
                  aria-label="Remove agent"
                >
                  <Trash2 className="size-4 text-slate-500" />
                </Button>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5 pl-6">
              {toolCatalog.map((tool) => {
                const selected = agent.tools.some((entry) => entry.ref === tool.ref);
                const issue = issuesByRef.get(tool.ref);
                return (
                  <button
                    key={tool.ref}
                    type="button"
                    disabled={!editable || busy}
                    onClick={() => toggleTool(index, tool.ref)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                      selected
                        ? "border-[var(--accent)] bg-[var(--accent-light)] text-[var(--text-2)]"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                      issue?.code === "connector_missing" && selected && "border-amber-300"
                    )}
                    title={tool.description}
                  >
                    {tool.label}
                  </button>
                );
              })}
              {agent.tools.length === 0 && (
                <Badge variant="secondary" className="text-[10px]">No tools (LLM only)</Badge>
              )}
            </div>
          </div>
        ))}

        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={addAgent}>
              <Plus className="size-3.5" />
              Add agent
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => void onSave(roster)}>
              Save roster
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
