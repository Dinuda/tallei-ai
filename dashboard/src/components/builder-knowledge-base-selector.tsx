"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-fetch";

export type KnowledgeBaseSelectionOutput = {
  answerText: string;
  requirementId: string;
  value: {
    mode: "sources";
    sources: Array<
      | { type: "tallei_memory" }
      | { type: "workspace_memory" }
      | { type: "knowledge_base"; id: string }
      | { type: "google_doc"; id: string }
    >;
    externalDataToolkits?: string[];
  };
};

type KnowledgeBase = {
  id: string;
  name: string;
  kind: "custom_faq" | "google_doc";
};

type ConnectedSearchToolkit = {
  toolkit: string;
  name: string;
  connected: boolean;
};

type RecalledPreference = {
  id: string;
  text: string;
  category?: string | null;
};

function buildOutput(
  requirementId: string,
  includeTallei: boolean,
  includeWorkspace: boolean,
  knowledgeBases: KnowledgeBase[],
  selectedKbIds: string[],
  selectedExternalToolkits: string[],
): KnowledgeBaseSelectionOutput {
  const sources: KnowledgeBaseSelectionOutput["value"]["sources"] = [];
  if (includeTallei) sources.push({ type: "tallei_memory" });
  if (includeWorkspace) sources.push({ type: "workspace_memory" });
  for (const kb of knowledgeBases) {
    if (!selectedKbIds.includes(kb.id)) continue;
    if (kb.kind === "google_doc") sources.push({ type: "google_doc", id: kb.id });
    else sources.push({ type: "knowledge_base", id: kb.id });
  }
  const labels = [
    includeTallei ? "Tallei memory" : null,
    includeWorkspace ? "Workspace memory" : null,
    ...knowledgeBases.filter((kb) => selectedKbIds.includes(kb.id)).map((kb) => kb.name),
    ...selectedExternalToolkits.map((toolkit) => `${toolkit} search`),
  ].filter(Boolean);
  return {
    requirementId,
    answerText: labels.length > 0 ? `Use ${labels.join(", ")}` : "Use no knowledge sources",
    value: {
      mode: "sources",
      sources,
      ...(selectedExternalToolkits.length > 0 ? { externalDataToolkits: selectedExternalToolkits } : {}),
    },
  };
}

export function BuilderKnowledgeBaseSelector({
  completedOutput,
  onComplete,
  requirementId,
  connectedSearchToolkits = [],
  recalledPreferences = [],
}: {
  completedOutput?: KnowledgeBaseSelectionOutput | null;
  onComplete?: (output: KnowledgeBaseSelectionOutput) => void;
  requirementId: string;
  connectedSearchToolkits?: ConnectedSearchToolkit[];
  recalledPreferences?: RecalledPreference[];
}) {
  const [includeTallei, setIncludeTallei] = useState(true);
  const [includeWorkspace, setIncludeWorkspace] = useState(true);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [selectedExternalToolkits, setSelectedExternalToolkits] = useState<string[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [connectorToolkits, setConnectorToolkits] = useState<ConnectedSearchToolkit[]>(connectedSearchToolkits);

  useEffect(() => {
    if (completedOutput) return;
    void apiFetch("/api/knowledge-bases", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) return;
        const rows = Array.isArray(payload.knowledgeBases) ? payload.knowledgeBases as KnowledgeBase[] : [];
        setKnowledgeBases(rows);
      })
      .catch(() => undefined);
  }, [completedOutput]);

  useEffect(() => {
    if (connectedSearchToolkits.length > 0) {
      setConnectorToolkits(connectedSearchToolkits);
      return;
    }
    if (completedOutput) return;
    void apiFetch("/api/connectors", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) return;
        const accounts = Array.isArray(payload.accounts) ? payload.accounts as Array<{ toolkit?: string; connected?: boolean }> : [];
        const connected = new Set(
          accounts
            .filter((account) => account.connected !== false && typeof account.toolkit === "string")
            .map((account) => account.toolkit!.toLowerCase()),
        );
        if (connected.size === 0) return;
        setConnectorToolkits((current) => {
          if (current.length > 0) return current;
          return [...connected].map((toolkit) => ({
            toolkit,
            name: `${toolkit} search`,
            connected: true,
          }));
        });
      })
      .catch(() => undefined);
  }, [completedOutput, connectedSearchToolkits]);

  if (completedOutput) {
    return (
      <div className="my-3 border border-[#d1d5db] bg-white">
        <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-2">
          <p className="text-[10px] font-semibold tracking-[0.1em] text-[#6b7280] uppercase">Knowledge sources selected</p>
        </div>
        <div className="p-4 text-[13px] leading-6 text-[#111827]">{completedOutput.answerText}</div>
      </div>
    );
  }

  function toggleKb(id: string) {
    setSelectedKbIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  }

  function toggleExternalToolkit(toolkit: string) {
    setSelectedExternalToolkits((current) =>
      current.includes(toolkit) ? current.filter((entry) => entry !== toolkit) : [...current, toolkit],
    );
  }

  function submit() {
    onComplete?.(buildOutput(
      requirementId,
      includeTallei,
      includeWorkspace,
      knowledgeBases,
      selectedKbIds,
      selectedExternalToolkits,
    ));
  }

  function submitDefaults() {
    onComplete?.(buildOutput(requirementId, true, true, knowledgeBases, [], []));
  }

  const availableExternalToolkits = connectorToolkits.filter((entry) => entry.connected);

  return (
    <div className="w-full border border-[#d1d5db] bg-white">
      <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-3">
        <h2 className="text-[14px] font-bold tracking-[-0.02em] text-[#111827]">Choose knowledge sources</h2>
        <p className="mt-0.5 text-[13px] text-[#6b7280]">
          Tallei and workspace memory need no URLs. Workspace memory includes inter-loop history from prior runs in this workspace.
        </p>
      </div>
      <div className="space-y-4 p-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Built-in memory</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeTallei} onChange={() => setIncludeTallei((value) => !value)} />
            Tallei internal memory
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeWorkspace} onChange={() => setIncludeWorkspace((value) => !value)} />
            Workspace memory (includes prior loop runs)
          </label>
        </div>

        {recalledPreferences.length > 0 ? (
          <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
            <p className="font-medium">Saved preferences found</p>
            <p className="mt-1 text-xs text-amber-800">You will confirm these before the loop uses them.</p>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
              {recalledPreferences.slice(0, 4).map((preference) => (
                <li key={preference.id}>{preference.text}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {knowledgeBases.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Additional workspace collections</p>
            {knowledgeBases.map((kb) => (
              <label key={kb.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={selectedKbIds.includes(kb.id)} onChange={() => toggleKb(kb.id)} />
                {kb.name} <span className="text-xs text-slate-500">({kb.kind === "google_doc" ? "Google Doc" : "FAQ"})</span>
              </label>
            ))}
            <p className="text-xs text-slate-500">Manage FAQs and Google Docs under workspace knowledge settings.</p>
          </div>
        ) : null}

        {availableExternalToolkits.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Optional: product and user data from connected apps</p>
            {availableExternalToolkits.map((entry) => (
              <label key={entry.toolkit} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedExternalToolkits.includes(entry.toolkit)}
                  onChange={() => toggleExternalToolkit(entry.toolkit)}
                />
                {entry.name}
              </label>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" onClick={submitDefaults}>
            Use defaults
          </Button>
          <Button onClick={submit}>
            <Check className="mr-2 size-4" />
            Confirm sources
          </Button>
        </div>
      </div>
    </div>
  );
}
