"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type DynamicToolUIPart } from "ai";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { apiFetch, getStoredWorkspaceId } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type BindingRow = { connector: string; capability: string; optional?: boolean };

function formatPatchSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as { missingSlots?: string[]; spec?: { bindings?: BindingRow[] } };
  const bindings = row.spec?.bindings?.map((b) => `${b.connector}:${b.capability}`).join(", ");
  const missing = row.missingSlots?.length ? `Still needed: ${row.missingSlots.join(", ")}` : "Ready to compile";
  return bindings ? `Bindings: ${bindings}. ${missing}` : missing;
}

function formatConnectorSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as { connectors?: Array<{ slug: string; connected: boolean }> };
  if (!row.connectors?.length) return "No connectors found in workspace.";
  return row.connectors
    .map((c) => `${c.slug}: ${c.connected ? "connected" : "not connected"}`)
    .join(", ");
}

function ConductorToolPart({ part }: { part: DynamicToolUIPart }) {
  const toolName = part.type.replace(/^tool-/, "");
  const title =
    toolName === "patchLoopSpec"
      ? "Update loop configuration"
      : toolName === "listConnectors"
        ? "Workspace connectors"
        : toolName === "connectToolkit"
          ? "Start connector OAuth"
          : toolName;
  const summary =
    toolName === "patchLoopSpec"
      ? formatPatchSummary(part.output)
      : toolName === "listConnectors"
        ? formatConnectorSummary(part.output)
        : null;

  return (
    <Tool defaultOpen={part.state === "output-available"}>
      <ToolHeader type="dynamic-tool" toolName={toolName} state={part.state} title={title} />
      <ToolContent>
        {summary ? <p className="text-sm text-[#3d5c18]">{summary}</p> : null}
        <ToolInput input={part.input} />
        <ToolOutput output={part.output} errorText={part.errorText} />
      </ToolContent>
    </Tool>
  );
}

export default function ConductorPage() {
  const params = useParams<{ loopId: string }>();
  const loopId = params.loopId;
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [missingSlots, setMissingSlots] = useState<string[]>([]);
  const [compiledPlanId, setCompiledPlanId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("draft");
  const [input, setInput] = useState("");

  const transport = useMemo(
    () => new DefaultChatTransport({
      api: `/api/loops/${loopId}/chat`,
      headers: (): Record<string, string> => {
        const ws = getStoredWorkspaceId();
        return ws ? { "X-Workspace-Id": ws } : {};
      },
    }),
    [loopId],
  );

  const { messages, sendMessage, status: chatStatus } = useChat({ transport });

  useEffect(() => {
    void (async () => {
      const res = await apiFetch(`/api/loops/${loopId}`);
      const data = await res.json();
      if (res.ok) {
        setSpec(data.spec ?? null);
        setStatus(data.loop?.status ?? "draft");
      }
    })();
  }, [loopId]);

  useEffect(() => {
    for (const message of messages) {
      for (const part of message.parts ?? []) {
        if (part.type === "tool-patchLoopSpec" && part.state === "output-available") {
          const output = part.output as { spec?: Record<string, unknown>; missingSlots?: string[] };
          if (output.spec) setSpec(output.spec);
          if (output.missingSlots) setMissingSlots(output.missingSlots);
        }
      }
    }
  }, [messages]);

  async function handleCompile() {
    const res = await apiFetch(`/api/loops/${loopId}/compile`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      alert(JSON.stringify(data.errors ?? data.error));
      return;
    }
    setCompiledPlanId(data.plan?.id ?? null);
  }

  async function handleActivate() {
    if (!compiledPlanId) {
      await handleCompile();
      return;
    }
    const res = await apiFetch(`/api/loops/${loopId}/activate`, {
      method: "POST",
      body: JSON.stringify({ compiledPlanId }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error ?? "Activation failed");
      return;
    }
    setStatus("active");
  }

  async function handleRun() {
    const res = await apiFetch(`/api/loops/${loopId}/runs`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) alert(data.error ?? "Run failed");
    else if (data.run?.id) {
      window.location.href = `/dashboard/loops/${loopId}/runs/${data.run.id}`;
    }
  }

  const readyToCompile = missingSlots.length === 0 && Boolean(spec);

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-[#182506]">Conductor</h1>
          <div className="flex gap-3 text-sm">
            <Link href={`/dashboard/loops/${loopId}/runs`} className="text-[#7eb71b] hover:underline">Runs</Link>
            <Link href="/dashboard/loops" className="text-[#7eb71b] hover:underline">Back</Link>
          </div>
        </div>

        <div className="min-h-[420px] space-y-3 rounded-xl border border-[#e4f5c6] bg-white p-4">
          {messages.map((message) => (
            <div key={message.id} className={message.role === "user" ? "text-right" : "text-left"}>
              {message.role === "user" ? (
                <div className="inline-block max-w-[90%] rounded-lg bg-[#7eb71b] px-3 py-2 text-sm text-white">
                  {message.parts?.map((part, i) => (part.type === "text" ? <span key={i}>{part.text}</span> : null))}
                </div>
              ) : (
                <div className="max-w-full space-y-2">
                  {message.parts?.map((part, i) => {
                    if (part.type === "text") {
                      return (
                        <div key={i} className="inline-block max-w-[90%] rounded-lg bg-[#f8fdf2] px-3 py-2 text-sm text-[#182506]">
                          {part.text}
                        </div>
                      );
                    }
                    if (part.type.startsWith("tool-")) {
                      return <ConductorToolPart key={i} part={part as DynamicToolUIPart} />;
                    }
                    return null;
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim()) return;
            void sendMessage({ text: input.trim() });
            setInput("");
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Do this, loop this, connect this..."
            disabled={chatStatus === "streaming"}
          />
          <Button type="submit" disabled={chatStatus === "streaming"}>Send</Button>
        </form>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Loop spec</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea readOnly className="min-h-[200px] font-mono text-xs" value={spec ? JSON.stringify(spec, null, 2) : "Loading..."} />
            {readyToCompile ? (
              <p className="mt-2 text-sm font-medium text-[#7eb71b]">Ready to compile</p>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">Missing: {missingSlots.join(", ") || "—"}</p>
            )}
            {readyToCompile ? (
              <p className="mt-2 text-xs text-[#3d5c18]">
                Ask Conductor to confirm connectors are connected, then Compile and Activate.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-2">
          <Button variant="outline" onClick={() => void handleCompile()} disabled={!readyToCompile}>Compile</Button>
          <Button onClick={() => void handleActivate()}>{status === "active" ? "Re-activate" : "Activate"}</Button>
          <Button variant="secondary" onClick={() => void handleRun()} disabled={status !== "active"}>Run now</Button>
          <Link href="/dashboard/approvals" className="text-center text-sm text-[#7eb71b] hover:underline">Approval inbox</Link>
        </div>
      </div>
    </div>
  );
}
