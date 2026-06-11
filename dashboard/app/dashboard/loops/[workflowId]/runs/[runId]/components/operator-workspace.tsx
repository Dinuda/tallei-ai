"use client";

import type { ReactNode } from "react";

import { ArtifactRenderer } from "@/components/renderers";
import type { OperatorBlock, OperatorView } from "@/lib/operator-view-types";
import { ContactsInputWorkspace, type ContactRow } from "./contacts-input";
import {
  DraftReviewWorkspace,
  MissingInputWorkspace,
  resolveInputFieldPlaceholder,
} from "./gate-workspace-ui";
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
  gateId: string | null;
  agentName: string;
  agentOutput?: string;
  centerBody?: string;
  activeCanvasArtifact?: CanvasArtifact | null;
  inputValue: string;
  onInputChange: (value: string) => void;
  onSubmitInput: () => void;
  busy: boolean;
  contactSourceKind: ContactSourceKind;
  recipientCount: number;
  onSaveContacts: (input: { csvText?: string; contacts?: ContactRow[]; audienceId?: string }) => Promise<void>;
  memoryItems: MemoryGateItem[];
  sourceItems: SourceGateItem[];
  addedSources: SourceGateItem[];
  selectedMemoryIds: Set<string>;
  selectedSourceIds: Set<string>;
  onToggleMemory: (gateId: string, memoryId: string, checked: boolean) => void;
  onToggleSource: (gateId: string, sourceId: string, checked: boolean) => void;
  onInspectMemory: (item: MemoryGateItem) => void;
  onAddSource: (gateId: string, source: SourceGateItem) => void;
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

function renderBlock(block: OperatorBlock, ctx: OperatorWorkspaceProps): ReactNode {
  const gateId = ctx.gateId ?? "";
  const surface = block.surface;

  if (surface === "input.text" || surface === "input.markdown" || surface === "input.file") {
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
        value={ctx.inputValue}
        onChange={ctx.onInputChange}
        onSubmit={ctx.onSubmitInput}
        submitDisabled={!ctx.inputValue.trim()}
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
        onSave={ctx.onSaveContacts}
      />
    );
  }

  if (surface === "review.memories" && gateId) {
    const items = readMemoryItemsFromBlockData(block.data).length > 0
      ? readMemoryItemsFromBlockData(block.data)
      : ctx.memoryItems;
    return (
      <>
        <MemoryReviewSurface
          gateId={gateId}
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

  if (surface === "review.sources" && gateId) {
    const items = readSourceItemsFromBlockData(block.data).length > 0
      ? readSourceItemsFromBlockData(block.data)
      : ctx.sourceItems;
    return (
      <>
        <SourceReviewSurface
          gateId={gateId}
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

export function operatorBandImperative(view: OperatorView): string {
  const primary = view.blocks.find((block) => block.required && !block.satisfied)?.surface
    ?? view.blocks[0]?.surface;
  const allInputsSatisfied = view.blocks.length > 0
    && view.blocks.every((block) => !block.required || block.satisfied || !block.surface.startsWith("input."));
  if (view.actions.includes("submit") && allInputsSatisfied) return "Required input is already available. Continue the run";
  if (primary === "input.markdown" || primary === "input.text") return "Paste the missing input below to continue";
  if (primary === "review.memories") return "Select which memories the next agent may use";
  if (primary === "review.sources") return "Select sources, add custom URLs, then approve or revise";
  if (primary === "review.draft" || primary === "review.email") return "Review the draft, then save & approve or request changes";
  if (primary === "review.preview") return "Review the final preview, then approve or request changes";
  if (primary === "input.contacts_csv" || primary === "input.audience_id") return "Add recipients for this send, then continue";
  if (primary === "confirm.send") return "Review the final draft, then approve send";
  return view.workspace.subtitle;
}

export function operatorApproveLabel(
  view: OperatorView,
  counts: { selectedMemories: number; selectedSources: number; recipientCount: number },
): string {
  const primary = view.blocks.find((block) => block.required && !block.satisfied)?.surface ?? view.blocks[0]?.surface;
  const allInputsSatisfied = view.blocks.length > 0
    && view.blocks.every((block) => !block.required || block.satisfied || !block.surface.startsWith("input."));
  if (primary === "review.memories" && counts.selectedMemories > 0) return `Approve (${counts.selectedMemories})`;
  if (primary === "review.sources" && counts.selectedSources > 0) return `Approve (${counts.selectedSources})`;
  if (primary === "review.draft" || primary === "review.email") return "Save & Approve";
  if (primary === "input.contacts_csv" || primary === "input.audience_id") {
    return counts.recipientCount > 0 ? `Continue (${counts.recipientCount} recipients)` : "Save contacts to continue";
  }
  if (view.actions.includes("submit") && allInputsSatisfied) return "Continue";
  if (view.actions.includes("submit")) return "Submit input";
  if (primary === "confirm.send") {
    return counts.recipientCount > 0 ? `Approve & send (${counts.recipientCount})` : "Approve & send";
  }
  return "Approve";
}

export function operatorApproveDisabled(
  view: OperatorView,
  counts: { inputValue: string; selectedSources: number; recipientCount: number },
): boolean {
  const primary = view.blocks.find((block) => block.required && !block.satisfied)?.surface ?? view.blocks[0]?.surface;
  const allInputsSatisfied = view.blocks.length > 0
    && view.blocks.every((block) => !block.required || block.satisfied || !block.surface.startsWith("input."));
  if (primary === "review.sources") return counts.selectedSources === 0;
  if (primary === "input.contacts_csv" || primary === "input.audience_id") return counts.recipientCount === 0;
  if (view.actions.includes("submit") && allInputsSatisfied) return false;
  if (view.actions.includes("submit")) return !counts.inputValue.trim();
  return false;
}

export function operatorShowRevise(view: OperatorView): boolean {
  return view.actions.includes("revise");
}

export function operatorShowPrimaryAction(view: OperatorView): boolean {
  if (!view.actions.includes("submit")) return true;
  const primary = view.blocks.find((block) => block.required && !block.satisfied)?.surface ?? view.blocks[0]?.surface;
  if (primary === "input.contacts_csv" || primary === "input.audience_id") return true;
  return view.blocks.length > 0
    && view.blocks.every((block) => !block.required || block.satisfied || !block.surface.startsWith("input."));
}
