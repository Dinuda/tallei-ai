"use client";

import { useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type MemoryGateItem = {
  id: string;
  excerpt: string;
  include?: boolean;
  score?: number;
  confidence?: number;
  reason?: string;
  evidenceRole?: string;
  metadata?: Record<string, unknown>;
};

export type SourceGateItem = {
  id: string;
  title: string;
  url: string;
  snippet: string;
  include?: boolean;
};

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function memoryItemSummary(item: MemoryGateItem) {
  return item.excerpt.replace(/\s+/g, " ").trim();
}

function memoryItemTitle(item: MemoryGateItem) {
  const meta = item.metadata;
  if (meta && typeof meta.title === "string" && meta.title.trim()) return meta.title.trim();
  if (meta && typeof meta.key === "string" && meta.key.trim()) return titleCase(meta.key.trim());
  const summary = memoryItemSummary(item);
  const words = summary.split(" ").slice(0, 8).join(" ");
  return words.length < summary.length ? `${words}…` : words;
}

function memoryItemMeta(item: MemoryGateItem) {
  const shortId = item.id.length > 8 ? `${item.id.slice(0, 8)}…` : item.id;
  const parts = [shortId];
  if (item.evidenceRole) parts.push(titleCase(item.evidenceRole));
  if (typeof item.confidence === "number") parts.push(`${Math.round(item.confidence * 100)}% match`);
  else if (typeof item.score === "number") parts.push(`score ${item.score.toFixed(2)}`);
  return parts.join(" · ");
}

export function MemoryReviewSurface({
  gateId,
  items,
  selectedIds,
  onToggle,
  onInspect,
}: {
  gateId: string;
  items: MemoryGateItem[];
  selectedIds: Set<string>;
  onToggle: (gateId: string, memoryId: string, checked: boolean) => void;
  onInspect: (item: MemoryGateItem) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-[#9ca3af]">No validated memories to review.</p>
    );
  }

  return (
    <div>
      {items.map((item) => {
        const selected = selectedIds.has(item.id);
        const title = memoryItemTitle(item);
        const summary = memoryItemSummary(item);
        const meta = memoryItemMeta(item);
        return (
          <div
            key={item.id}
            className={cn(
              "flex items-start gap-4 border-b border-[#e5e7eb] px-7 py-4 transition-colors hover:bg-[#fafafa]",
              selected && "bg-[#f9fafb] ring-1 ring-inset ring-[#111827]/10",
            )}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={(checked) => onToggle(gateId, item.id, checked === true)}
              aria-label={`Include memory ${title}`}
              className="mt-1 rounded-[2px]"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-[#111827]">{title}</p>
              <p className="mt-1 line-clamp-2 text-[14px] leading-6 text-[#4b5563]">{summary}</p>
              <p className="mt-1.5 font-mono text-[12px] text-[#9ca3af]">{meta}</p>
            </div>
            <button
              type="button"
              onClick={() => onInspect(item)}
              className="shrink-0 pt-0.5 text-[13px] text-[#6b7280] underline-offset-2 hover:text-[#111827] hover:underline"
            >
              View →
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function SourceReviewSurface({
  gateId,
  items,
  addedSources,
  selectedIds,
  onToggle,
  onAddSource,
}: {
  gateId: string;
  items: SourceGateItem[];
  addedSources: SourceGateItem[];
  selectedIds: Set<string>;
  onToggle: (gateId: string, sourceId: string, checked: boolean) => void;
  onAddSource: (gateId: string, source: SourceGateItem) => void;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [snippet, setSnippet] = useState("");
  const allItems = [...items, ...addedSources];

  function handleAdd() {
    const trimmedUrl = url.trim();
    const trimmedTitle = title.trim();
    const trimmedSnippet = snippet.trim();
    if (!trimmedUrl || !trimmedTitle || !trimmedSnippet) return;
    onAddSource(gateId, {
      id: trimmedUrl,
      title: trimmedTitle,
      url: trimmedUrl,
      snippet: trimmedSnippet,
      include: true,
    });
    setUrl("");
    setTitle("");
    setSnippet("");
  }

  return (
    <div>
      {allItems.length === 0 ? (
        <p className="py-10 text-center text-sm text-[#9ca3af]">No search sources yet. Add a custom source below.</p>
      ) : null}
      {allItems.map((item) => {
        const selected = selectedIds.has(item.id);
        return (
          <div
            key={item.id}
            className={cn(
              "flex items-start gap-4 border-b border-[#e5e7eb] px-7 py-4 transition-colors hover:bg-[#fafafa]",
              selected && "bg-[#f9fafb] ring-1 ring-inset ring-[#111827]/10",
            )}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={(checked) => onToggle(gateId, item.id, checked === true)}
              aria-label={`Include source ${item.title}`}
              className="mt-1 rounded-[2px]"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-[#111827]">{item.title}</p>
              <p className="mt-1 line-clamp-2 text-[14px] leading-6 text-[#4b5563]">{item.snippet}</p>
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 block truncate font-mono text-[12px] text-[#2563eb] hover:underline"
              >
                {item.url}
              </a>
            </div>
          </div>
        );
      })}
      <div className="space-y-3 border-t border-[#e5e7eb] bg-[#fafafa] px-7 py-5">
        <p className="text-[13px] font-semibold text-[#374151]">Add source</p>
        <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" className="bg-white" />
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" className="bg-white" />
        <textarea
          value={snippet}
          onChange={(event) => setSnippet(event.target.value)}
          placeholder="Snippet or notes about this source"
          rows={3}
          className="w-full resize-none rounded-md border border-[#d1d5db] bg-white px-3 py-2 text-[14px] text-[#111827] outline-none focus:ring-2 focus:ring-[#111827]/10"
        />
        <Button type="button" variant="outline" onClick={handleAdd} disabled={!url.trim() || !title.trim() || !snippet.trim()}>
          Add source
        </Button>
      </div>
    </div>
  );
}

export function readMemoryItemsFromBlockData(data: unknown): MemoryGateItem[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const items = (data as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is MemoryGateItem =>
    Boolean(item)
    && typeof item === "object"
    && typeof (item as MemoryGateItem).id === "string"
    && typeof (item as MemoryGateItem).excerpt === "string",
  );
}

export function readSourceItemsFromBlockData(data: unknown): SourceGateItem[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const items = (data as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is SourceGateItem =>
    Boolean(item)
    && typeof item === "object"
    && typeof (item as SourceGateItem).id === "string"
    && typeof (item as SourceGateItem).title === "string",
  );
}
