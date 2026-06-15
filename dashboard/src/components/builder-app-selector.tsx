"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Toolkit = {
  slug: string;
  name: string;
  description: string;
  logo: string;
  category?: string;
};

export type AppSelectionOutput = {
  selectedToolkits: Array<{ slug: string; name: string }>;
  answerText: string;
};

export function BuilderAppSelector({
  allowMultiple,
  completedOutput,
  onComplete,
  question,
  recommendedToolkitSlugs,
}: {
  allowMultiple: boolean;
  completedOutput?: AppSelectionOutput | null;
  onComplete?: (output: AppSelectionOutput) => void;
  question: string;
  recommendedToolkitSlugs: string[];
}) {
  const [toolkits, setToolkits] = useState<Toolkit[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(!completedOutput);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (completedOutput) return;
    let cancelled = false;
    void fetch("/api/connectors/composio/toolkits", { cache: "no-store" })
      .then(async (response) => {
        if (cancelled) return;
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not load available apps");
        setToolkits(Array.isArray(payload.toolkits) ? payload.toolkits : []);
      })
      .catch((cause) => {
        if (cancelled) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Could not load available apps");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [completedOutput]);

  const recommended = useMemo(
    () => new Set(recommendedToolkitSlugs.map((slug) => slug.toLowerCase())),
    [recommendedToolkitSlugs],
  );
  const visibleToolkits = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...toolkits]
      .filter((toolkit) => !normalizedQuery
        || toolkit.name.toLowerCase().includes(normalizedQuery)
        || toolkit.slug.toLowerCase().includes(normalizedQuery)
        || toolkit.description.toLowerCase().includes(normalizedQuery))
      .sort((left, right) => {
        const recommendationOrder = Number(recommended.has(right.slug.toLowerCase())) - Number(recommended.has(left.slug.toLowerCase()));
        return recommendationOrder || left.name.localeCompare(right.name);
      });
  }, [query, recommended, toolkits]);

  if (completedOutput) {
    return (
      <div className="my-3 border border-[#d1d5db] bg-white">
        <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-2">
          <p className="text-[10px] font-semibold tracking-[0.1em] text-[#6b7280] uppercase">Apps selected</p>
        </div>
        <div className="flex flex-wrap gap-2 p-4">
          {completedOutput.selectedToolkits.map((toolkit) => (
            <div key={toolkit.slug} className="flex items-center gap-2 border border-[#e5e7eb] bg-white px-3 py-2">
              <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden bg-white border border-[#e5e7eb]">
                <img alt="" className="size-5 object-contain" src={`https://logos.composio.dev/api/${toolkit.slug}`} />
              </span>
              <span className="text-sm font-medium text-[#111827]">{toolkit.name}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function toggle(toolkit: Toolkit) {
    setSelected((current) => {
      if (current.includes(toolkit.slug)) return current.filter((slug) => slug !== toolkit.slug);
      return allowMultiple ? [...current, toolkit.slug] : [toolkit.slug];
    });
  }

  function submit() {
    const selectedToolkits = selected.flatMap((slug) => {
      const toolkit = toolkits.find((candidate) => candidate.slug === slug);
      return toolkit ? [{ slug: toolkit.slug, name: toolkit.name }] : [];
    });
    if (selectedToolkits.length === 0) return;
    onComplete?.({
      selectedToolkits,
      answerText: `Use ${selectedToolkits.map((toolkit) => toolkit.name).join(", ")}`,
    });
  }

  return (
    <div className="w-full border border-[#d1d5db] bg-white">
      <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-3">
        <h2 className="text-[14px] font-bold tracking-[-0.02em] text-[#111827]">{question}</h2>
        <p className="mt-0.5 text-[13px] text-[#6b7280]">Choose the apps you already use. You can connect an account next.</p>
      </div>

      <div className="px-4 py-3">
        <label className="flex items-center gap-2 border border-[#d1d5db] bg-white px-3 py-2.5 focus-within:border-[#111827]">
          <Search className="size-4 text-[#9ca3af]" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#9ca3af]"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search apps"
            value={query}
          />
        </label>

        <div className="mt-3 max-h-[340px] overflow-y-auto border border-[#d1d5db] bg-white">
          {loading && <div className="flex items-center justify-center gap-2 py-12 text-sm text-[#6b7280]"><LoaderCircle className="size-4 animate-spin" /> Loading apps...</div>}
          {!loading && visibleToolkits.map((toolkit) => {
            const isSelected = selected.includes(toolkit.slug);
            return (
              <button
                className={cn("flex w-full items-center gap-3 px-3 py-3 text-left transition-colors border-b border-[#e5e7eb] last:border-b-0", isSelected ? "bg-[#fafafa]" : "hover:bg-[#fafafa]")}
                key={toolkit.slug}
                onClick={() => toggle(toolkit)}
                type="button"
              >
                <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden border border-[#e5e7eb] bg-white">
                  <img alt="" className="size-7 object-contain" src={toolkit.logo || `https://logos.composio.dev/api/${toolkit.slug}`} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium text-[#111827]">
                    {toolkit.name}
                    {recommended.has(toolkit.slug.toLowerCase()) && <span className="border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">Suggested</span>}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-[#6b7280]">{toolkit.description || "Connect this app to your loop"}</span>
                </span>
                <span className={cn("flex size-5 shrink-0 items-center justify-center border", isSelected ? "bg-[#111827] text-white border-[#111827]" : "border-[#d1d5db]")}>{isSelected && <Check className="size-3" />}</span>
              </button>
            );
          })}
          {!loading && visibleToolkits.length === 0 && <div className="py-10 text-center text-sm text-[#6b7280]">No apps match that search.</div>}
        </div>

        {error && <p className="mt-3 border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
        <div className="mt-4 flex justify-end">
          <Button className="bg-[#111827] text-white hover:opacity-85 border-0" disabled={selected.length === 0} onClick={submit} style={{ borderRadius: 0 }}>Use selected apps</Button>
        </div>
      </div>
    </div>
  );
}
