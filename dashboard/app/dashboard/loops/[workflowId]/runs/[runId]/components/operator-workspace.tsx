"use client";

import { useState, type ReactNode } from "react";

import { ArtifactRenderer } from "@/components/renderers";
import type { OperatorBlock, OperatorView } from "@/lib/operator-view-types";
import { ContactsInputWorkspace, type ContactRow } from "./contacts-input";
import {
  DraftReviewWorkspace,
  MissingInputWorkspace,
  resolveInputFieldPlaceholder,
} from "./operator-interaction-ui";
import {
  MemoryReviewSurface,
  readMemoryItemsFromBlockData,
  readSourceItemsFromBlockData,
  SourceReviewSurface,
  type MemoryGateItem,
  type SourceGateItem,
} from "./review-canvases";
import { cn } from "@/lib/utils";
import type { ContactSourceKind } from "@/lib/operator-view-types";
import { EditableAgentOutput } from "./editable-agent-output";

function EditorialWorkspaceShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden border border-[#d1d5db] bg-white", className)}>
      {children}
    </div>
  );
}

type CanvasArtifact = {
  id: string;
  artifact_key: string;
  version: number;
  kind: string;
  body: string;
  invalidated_at?: string | null;
  data_json?: Record<string, unknown>;
};

export type OperatorWorkspaceProps = {
  operatorView: OperatorView;
  runId: string;
  interactionId: string | null;
  agentName: string;
  agentOutput?: string;
  centerBody?: string;
  activeCanvasArtifact?: CanvasArtifact | null;
  inputValues: Record<string, string>;
  onInputChange: (blockId: string, value: string) => void;
  onSubmitInput: () => void;
  busy: boolean;
  contactSourceKind: ContactSourceKind;
  recipientCount: number;
  onSaveContacts: (requirementKey: string, input: { csvText?: string; contacts?: ContactRow[]; audienceId?: string }) => Promise<void>;
  memoryItems: MemoryGateItem[];
  sourceItems: SourceGateItem[];
  addedSources: SourceGateItem[];
  selectedMemoryIds: Set<string>;
  selectedSourceIds: Set<string>;
  onToggleMemory: (interactionId: string, memoryId: string, checked: boolean) => void;
  onToggleSource: (interactionId: string, sourceId: string, checked: boolean) => void;
  onInspectMemory: (item: MemoryGateItem) => void;
  onAddSource: (interactionId: string, source: SourceGateItem) => void;
  reviseFeedback: string;
  onReviseFeedbackChange: (value: string) => void;
  onSaveCanvasEmail: (
    artifact: CanvasArtifact,
    value: { design: unknown; html: string; text?: string; subject?: string; preview?: string },
  ) => Promise<void>;
  onSaveAgentOutput: (text: string) => Promise<void>;
};

function readContactSourceKind(props?: Record<string, unknown>): ContactSourceKind {
  const contactSource = props?.contactSource;
  if (contactSource && typeof contactSource === "object" && !Array.isArray(contactSource)) {
    const kind = (contactSource as Record<string, unknown>).kind;
    if (kind === "configured" || kind === "uploaded" || kind === "operator_input" || kind === "none") {
      return kind;
    }
  }
  return "uploaded";
}

function blockAgentOutput(block: OperatorBlock, fallback?: string): string {
  if (block.data && typeof block.data === "object" && !Array.isArray(block.data)) {
    const text = (block.data as Record<string, unknown>).agentOutput;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return fallback ?? "";
}

function ConnectorSetupWorkspace({ block, runId, busy }: { block: OperatorBlock; runId: string; busy: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const setup = block.kind === "connect_connector" ? block.data : block.props?.connectorSetup;
  const row = setup && typeof setup === "object" && !Array.isArray(setup)
    ? setup as Record<string, unknown>
    : {};
  const toolkit = typeof row.toolkit === "string" ? row.toolkit : "connected app";
  const actionSlug = typeof row.actionSlug === "string" ? row.actionSlug : "";

  async function connect() {
    setError(null);
    try {
      const redirectUrl = new URL(window.location.href);
      redirectUrl.searchParams.set("connector_return", "1");
      redirectUrl.searchParams.set("app", toolkit);
      const response = await fetch("/api/connectors/composio/auth-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app_key: toolkit,
          required_scopes: [toolkit],
          redirect_uri: redirectUrl.toString(),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `Failed to connect ${toolkit}`);
      if (typeof payload.auth_session_id !== "string" || typeof payload.setup_url !== "string") {
        throw new Error("Connector setup response is incomplete");
      }
      window.sessionStorage.setItem("tallei:pending-connector-auth", JSON.stringify({
        appKey: toolkit,
        authSessionId: payload.auth_session_id,
        scopes: [toolkit],
        runId,
        startedAt: Date.now(),
      }));
      window.location.assign(payload.setup_url);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : `Failed to connect ${toolkit}`);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-7 py-10">
      <p className="text-[12px] font-semibold tracking-[0.12em] text-[#2d5a87] uppercase">Connector agent</p>
      <h3 className="mt-3 text-[24px] font-bold tracking-[-0.03em] text-[#111827]">Connect {toolkit}</h3>
      <p className="mt-3 max-w-xl text-[15px] leading-7 text-[#4b5563]">
        This workflow is drafted and ready. Connect {toolkit} so the connector agent can execute
        {actionSlug ? ` ${actionSlug}` : " the selected action"}, then use Continue to verify the connection and resume.
      </p>
      <div className="mt-7">
        <button
          type="button"
          disabled={busy}
          onClick={() => void connect()}
          className="border border-[#1e4070] bg-[#1e4070] px-5 py-3 text-[14px] font-semibold text-white hover:bg-[#17355e] disabled:opacity-50"
        >
          Connect {toolkit}
        </button>
        {error ? <p className="mt-3 text-[13px] text-[#991b1b]">{error}</p> : null}
      </div>
    </div>
  );
}

function renderBlock(block: OperatorBlock, ctx: OperatorWorkspaceProps): ReactNode {
  const interactionId = ctx.interactionId ?? "";
  const surface = block.surface;

  if (block.kind === "connect_connector") {
    return <ConnectorSetupWorkspace block={block} runId={ctx.runId} busy={ctx.busy} />;
  }

  if (block.kind === "confirm_action") {
    const data = block.data && typeof block.data === "object" && !Array.isArray(block.data)
      ? block.data as Record<string, unknown>
      : {};
    return (
      <div className="space-y-5 px-7 py-6">
        <div>
          <p className="text-[12px] font-semibold tracking-[0.12em] text-[#2d5a87] uppercase">Validated external action</p>
          <h3 className="mt-2 text-[20px] font-bold text-[#111827]">{String(data.contractRef ?? block.id)}</h3>
          <p className="mt-1 text-[13px] text-[#6b7280]">Effect: {String(data.effect ?? "external action")}</p>
        </div>
        <pre className="max-h-[420px] overflow-auto border border-[#d1d5db] bg-[#f8fafc] p-4 text-[12px] leading-5 text-[#111827]">
          {JSON.stringify(data.payload ?? {}, null, 2)}
        </pre>
      </div>
    );
  }

  if (block.kind === "review_artifact") {
    const output = blockAgentOutput(block, ctx.agentOutput ?? ctx.centerBody);
    const template = ctx.activeCanvasArtifact?.data_json?.emailTemplate;
    return (
      <DraftReviewWorkspace agentOutput={output}>
        {ctx.activeCanvasArtifact && template ? (
          <ArtifactRenderer
            artifact={{ ...ctx.activeCanvasArtifact, invalidated_at: ctx.activeCanvasArtifact.invalidated_at ?? null }}
            runId={ctx.runId}
            saving={ctx.busy}
            onSave={async (data) => {
              await ctx.onSaveCanvasEmail(ctx.activeCanvasArtifact!, data as Parameters<typeof ctx.onSaveCanvasEmail>[1]);
            }}
          />
        ) : output ? (
          <EditableAgentOutput text={output} saving={ctx.busy} forceEditing onSave={ctx.onSaveAgentOutput} />
        ) : undefined}
      </DraftReviewWorkspace>
    );
  }

  if (surface === "input.text" || surface === "input.markdown" || surface === "input.file") {
    if (block.props?.connectorSetup) {
      return <ConnectorSetupWorkspace block={block} runId={ctx.runId} busy={ctx.busy} />;
    }
    if (block.satisfied) {
      return (
        <div className="flex min-h-0 flex-1 flex-col justify-center px-7 py-10">
          <p className="text-[13px] font-medium text-[#9b9a97]">Input already saved</p>
          <p className="mt-2 text-[15px] leading-7 text-[#37352f]">
            The required input is already in memory. Use the action button above to continue.
          </p>
        </div>
      );
    }
    return (
      <MissingInputWorkspace
        agentOutput={blockAgentOutput(block, ctx.agentOutput)}
        agentName={ctx.agentName}
        fieldLabel={block.label ?? "Required input"}
        fieldPlaceholder={block.description ?? resolveInputFieldPlaceholder([block.id])}
        value={ctx.inputValues[block.id] ?? ""}
        onChange={(value) => ctx.onInputChange(block.id, value)}
        onSubmit={ctx.onSubmitInput}
        submitDisabled={!ctx.inputValues[block.id]?.trim()}
        busy={ctx.busy}
      />
    );
  }

  if (surface === "input.contacts_csv" || surface === "input.audience_id") {
    if (block.satisfied) {
      return (
        <div className="flex min-h-0 flex-1 flex-col justify-center px-7 py-10">
          <p className="text-[13px] font-medium text-[#9b9a97]">Recipients saved</p>
          <p className="mt-2 text-[15px] leading-7 text-[#37352f]">
            {ctx.recipientCount > 0
              ? `${ctx.recipientCount} contacts are already saved. Use Continue to move forward.`
              : "Recipients are already saved. Use Continue to move forward."}
          </p>
        </div>
      );
    }
    return (
      <ContactsInputWorkspace
        contactSourceKind={readContactSourceKind(block.props)}
        recipientCount={ctx.recipientCount}
        busy={ctx.busy}
        onSave={(input) => ctx.onSaveContacts(block.id, input)}
      />
    );
  }

  if (surface === "review.memories" && interactionId) {
    const items = readMemoryItemsFromBlockData(block.data).length > 0
      ? readMemoryItemsFromBlockData(block.data)
      : ctx.memoryItems;
    return (
      <>
        <MemoryReviewSurface
          gateId={interactionId}
          items={items}
          selectedIds={ctx.selectedMemoryIds}
          onToggle={ctx.onToggleMemory}
          onInspect={ctx.onInspectMemory}
        />
        <div className="mt-auto border-t border-[#d1d5db] bg-[#fafafa] px-7 py-3">
          <p className="text-[13px] text-[#6b7280]">
            {items.length} proposed · {ctx.selectedMemoryIds.size} selected
          </p>
        </div>
      </>
    );
  }

  if (surface === "review.sources" && interactionId) {
    const items = readSourceItemsFromBlockData(block.data).length > 0
      ? readSourceItemsFromBlockData(block.data)
      : ctx.sourceItems;
    return (
      <>
        <SourceReviewSurface
          gateId={interactionId}
          items={items}
          addedSources={ctx.addedSources}
          selectedIds={ctx.selectedSourceIds}
          onToggle={ctx.onToggleSource}
          onAddSource={ctx.onAddSource}
        />
        <div className="mt-auto space-y-3 border-t border-[#d1d5db] bg-[#fafafa] px-7 py-4">
          <p className="text-[13px] text-[#6b7280]">
            {items.length + ctx.addedSources.length} proposed · {ctx.selectedSourceIds.size} selected
          </p>
          <textarea
            value={ctx.reviseFeedback}
            onChange={(event) => ctx.onReviseFeedbackChange(event.target.value)}
            placeholder="Optional feedback when revising (re-runs research with your notes)"
            rows={2}
            className="w-full resize-none rounded-md border border-[#d1d5db] bg-white px-3 py-2 text-[13px] text-[#111827] outline-none focus:ring-2 focus:ring-[#111827]/10"
          />
        </div>
      </>
    );
  }

  if (surface === "review.draft") {
    const output = blockAgentOutput(block, ctx.agentOutput ?? ctx.centerBody);
    return output ? (
      <div className="px-7 py-6">
        <EditableAgentOutput text={output} saving={ctx.busy} forceEditing onSave={ctx.onSaveAgentOutput} />
      </div>
    ) : (
      <p className="py-12 text-center text-sm text-[#9ca3af]">No draft output available yet.</p>
    );
  }

  if (surface === "review.email" || surface === "review.preview" || surface === "confirm.send") {
    const template = ctx.activeCanvasArtifact?.data_json?.emailTemplate;
    const agentOutput = blockAgentOutput(block, ctx.agentOutput ?? ctx.centerBody);
    return (
      <DraftReviewWorkspace agentOutput={agentOutput}>
        {ctx.activeCanvasArtifact && template ? (
          <ArtifactRenderer
            artifact={{
              ...ctx.activeCanvasArtifact,
              invalidated_at: ctx.activeCanvasArtifact.invalidated_at ?? null,
            }}
            runId={ctx.runId}
            saving={ctx.busy}
            onSave={async (data) => {
              await ctx.onSaveCanvasEmail(ctx.activeCanvasArtifact!, data as Parameters<typeof ctx.onSaveCanvasEmail>[1]);
            }}
          />
        ) : agentOutput ? (
          <EditableAgentOutput
            text={agentOutput}
            saving={ctx.busy}
            forceEditing
            onSave={ctx.onSaveAgentOutput}
          />
        ) : undefined}
      </DraftReviewWorkspace>
    );
  }

  return (
    <p className="px-7 py-10 text-sm text-[#9ca3af]">
      Unsupported surface: {surface}
    </p>
  );
}

export function OperatorWorkspace(props: OperatorWorkspaceProps) {
  const { operatorView } = props;
  const activeBlocks = operatorView.blocks.filter((block) => block.required && !block.satisfied);
  const blocksToRender = activeBlocks.length > 0 ? activeBlocks : operatorView.blocks;

  if (blocksToRender.length === 0) {
    return null;
  }

  return (
    <EditorialWorkspaceShell className="flex h-full min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-[#e5e7eb] px-7 py-5">
        <h2 className="text-[20px] font-bold tracking-[-0.02em] text-[#111827]">
          {operatorView.workspace.title}
        </h2>
        <p className="mt-1.5 text-[14px] leading-6 text-[#6b7280]">
          {operatorView.workspace.subtitle}
          {operatorView.meta?.nextAgentName ? (
            <>
              {" "}
              <span className="font-medium text-[#374151]">Then → {operatorView.meta.nextAgentName}</span>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {blocksToRender.map((block) => (
          <div key={block.id} className="flex min-h-0 flex-1 flex-col">
            {renderBlock(block, props)}
          </div>
        ))}
      </div>
    </EditorialWorkspaceShell>
  );
}

export function OperatorViewStamp({ stamp }: { stamp: { tag: string; name: string } }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        className="shrink-0 border border-[#9bb8d9] bg-white/70 px-2 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-[#2d5a87] uppercase"
        style={{ fontFamily: "var(--font-title)" }}
      >
        {stamp.tag}
      </span>
      <span className="shrink-0 text-[15px] text-[#9bb8d9]">/</span>
      <span
        className="truncate text-[17px] font-semibold tracking-[-0.02em] text-[#1e4070]"
        style={{ fontFamily: "var(--font-title)" }}
      >
        {stamp.name}
      </span>
    </div>
  );
}

function primaryBlock(view: OperatorView): OperatorBlock | null {
  return view.blocks.find((block) => block.required && !block.satisfied) ?? view.blocks[0] ?? null;
}

export function operatorBandImperative(view: OperatorView): string {
  if (view.blocks.some((block) => block.kind === "connect_connector")) return "Connect the required app, then verify and continue";
  const primary = primaryBlock(view);
  const surface = primary?.surface;
  const allInputsSatisfied = view.blocks.length > 0
    && view.blocks.every((block) => !block.required || block.satisfied || !block.surface?.startsWith("input."));
  if (view.actions.some((action) => action.command === "submit_input") && allInputsSatisfied) return "Required input is already available. Continue the run";
  if (primary?.kind === "confirm_action") return "Review the validated external action, then approve or reject";
  if (primary?.kind === "review_artifact" && surface === "review.memories") return "Select which memories the next agent may use";
  if (primary?.kind === "review_artifact" && surface === "review.sources") return "Select sources, add custom URLs, then approve or revise";
  if (primary?.kind === "review_artifact" && (surface === "review.draft" || surface === "review.email")) {
    return "Review the draft, then save & approve or request changes";
  }
  if (primary?.kind === "review_artifact" && surface === "review.preview") return "Review the final preview, then approve or request changes";
  if (primary?.kind === "review_artifact" && surface === "confirm.send") return "Review the final draft, then approve send";
  if (surface === "input.markdown" || surface === "input.text") return "Paste the missing input below to continue";
  if (surface === "review.memories") return "Select which memories the next agent may use";
  if (surface === "review.sources") return "Select sources, add custom URLs, then approve or revise";
  if (surface === "review.draft" || surface === "review.email") return "Review the draft, then save & approve or request changes";
  if (surface === "review.preview") return "Review the final preview, then approve or request changes";
  if (surface === "input.contacts_csv" || surface === "input.audience_id") return "Add recipients for this send, then continue";
  if (surface === "confirm.send") return "Review the final draft, then approve send";
  return view.workspace.subtitle;
}

export function operatorApproveLabel(
  view: OperatorView,
  counts: { selectedMemories: number; selectedSources: number; recipientCount: number },
): string {
  const primaryAction = view.actions.find((action) => action.command === "approve"
    || action.command === "submit_input"
    || action.command === "verify_connection");
  if (primaryAction) return primaryAction.label;
  const primary = primaryBlock(view);
  const surface = primary?.surface;
  const allInputsSatisfied = view.blocks.length > 0
    && view.blocks.every((block) => !block.required || block.satisfied || !block.surface?.startsWith("input."));
  if (surface === "review.memories" && counts.selectedMemories > 0) return `Approve (${counts.selectedMemories})`;
  if (surface === "review.sources" && counts.selectedSources > 0) return `Approve (${counts.selectedSources})`;
  if (surface === "review.draft" || surface === "review.email") return "Save & Approve";
  if (surface === "input.contacts_csv" || surface === "input.audience_id") {
    return counts.recipientCount > 0 ? `Continue (${counts.recipientCount} recipients)` : "Save contacts to continue";
  }
  if (view.actions.some((action) => action.command === "submit_input") && allInputsSatisfied) return "Continue";
  if (view.actions.some((action) => action.command === "submit_input")) return "Submit input";
  if (surface === "confirm.send") {
    return counts.recipientCount > 0 ? `Approve & send (${counts.recipientCount})` : "Approve & send";
  }
  if (primary?.kind === "confirm_action") return "Approve action";
  return "Approve";
}

export function operatorApproveDisabled(
  view: OperatorView,
  counts: { inputValue: string; selectedSources: number; recipientCount: number },
): boolean {
  const primary = primaryBlock(view);
  const surface = primary?.surface;
  const allInputsSatisfied = view.blocks.length > 0
    && view.blocks.every((block) => !block.required || block.satisfied || !block.surface?.startsWith("input."));
  const primaryAction = view.actions.find((action) => action.command === "approve"
    || action.command === "submit_input"
    || action.command === "verify_connection");
  if (primaryAction && !primaryAction.enabled) return true;
  if (surface === "review.sources") return counts.selectedSources === 0;
  if (surface === "input.contacts_csv" || surface === "input.audience_id") return counts.recipientCount === 0;
  if (view.actions.some((action) => action.command === "submit_input") && allInputsSatisfied) return false;
  if (view.actions.some((action) => action.command === "submit_input")) return !counts.inputValue.trim();
  return false;
}

export function operatorShowRevise(view: OperatorView): boolean {
  return view.actions.some((action) => action.command === "revise");
}

export function operatorShowReject(view: OperatorView): boolean {
  return view.actions.some((action) => action.command === "reject");
}

export function operatorShowPrimaryAction(view: OperatorView): boolean {
  if (!view.actions.some((action) => action.command === "submit_input")) return true;
  const primary = primaryBlock(view);
  const surface = primary?.surface;
  if (surface === "input.contacts_csv" || surface === "input.audience_id") return true;
  return view.blocks.length > 0
    && view.blocks.every((block) => !block.required || block.satisfied || !block.surface?.startsWith("input."));
}
