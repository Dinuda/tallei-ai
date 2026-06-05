"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2, RefreshCw, Save, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type TemplateId = "blog_post" | "weekly_report" | "social_content" | "custom";

type BuilderProposal = {
  title: string;
  summary: string;
  templateId: TemplateId;
  definition: {
    goal: string;
    schedule: { cron: string; timezone: string };
    allowedToolRefs?: string[];
    plan?: {
      stages: Array<{
        id: string;
        kind: string;
        name?: string;
        label?: string;
        task?: string;
        toolRef?: string | null;
        approvalPolicy?: { channels?: string[] };
      }>;
    };
  };
  suggestedChannels: string[];
  suggestedToolRefs: string[];
  memories: Array<{ id: string; text: string }>;
  preferences: Array<{ id: string; text: string; category?: string | null }>;
  rationale: string[];
};

const templateOptions: Array<{ id: TemplateId; label: string }> = [
  { id: "custom", label: "Auto" },
  { id: "blog_post", label: "Blog post" },
  { id: "weekly_report", label: "Weekly report" },
  { id: "social_content", label: "Social content" },
];

export default function NewLoopBuilderPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [feedback, setFeedback] = useState("");
  const [templateId, setTemplateId] = useState<TemplateId>("custom");
  const [proposal, setProposal] = useState<BuilderProposal | null>(null);
  const [busy, setBusy] = useState<"propose" | "refine" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stages = useMemo(() => proposal?.definition.plan?.stages ?? [], [proposal]);

  async function requestProposal(mode: "propose" | "refine") {
    setBusy(mode);
    setError(null);
    try {
      const response = await fetch(`/api/loop-builder/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          templateId,
          feedback: feedback.trim() ? feedback : undefined,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `Failed to ${mode} loop`);
      setProposal(payload.proposal as BuilderProposal);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `Failed to ${mode} loop`);
    } finally {
      setBusy(null);
    }
  }

  async function saveProposal() {
    if (!proposal) return;
    setBusy("save");
    setError(null);
    try {
      const response = await fetch("/api/loop-builder/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Failed to save loop");
      router.push("/dashboard/loops");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save loop");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
            <Wand2 size={14} />
            Loop builder
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text)]">Create a loop</h1>
        </div>
        <Button asChild variant="outline" className="h-9 gap-1.5">
          <Link href="/dashboard/loops">
            <ArrowLeft size={14} />
            Back
          </Link>
        </Button>
      </header>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="space-y-4">
          <Card className="rounded-md p-4">
            <label className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">What should repeat?</label>
            <textarea
              className="mt-2 min-h-44 w-full rounded-md border border-[var(--border-light)] bg-white p-3 text-sm text-[var(--text)] outline-none focus:border-orange-400"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Example: Every Friday, create a weekly product update from memory, recent sources, and my previous writing style. Ask me to approve the draft before anything goes out."
            />

            <div className="mt-4 flex flex-wrap gap-2">
              {templateOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    templateId === option.id
                      ? "border-orange-500 bg-orange-50 text-orange-700"
                      : "border-[var(--border-light)] bg-white text-[var(--text-2)]"
                  }`}
                  onClick={() => setTemplateId(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                className="h-9 gap-1.5 bg-orange-500 text-white hover:bg-orange-600"
                disabled={!prompt.trim() || busy !== null}
                onClick={() => void requestProposal("propose")}
              >
                {busy === "propose" ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                Propose
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-9 gap-1.5"
                disabled={!prompt.trim() || busy !== null}
                onClick={() => void requestProposal("refine")}
              >
                {busy === "refine" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Refine
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-9 gap-1.5"
                disabled={!proposal || busy !== null}
                onClick={() => void saveProposal()}
              >
                {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Save loop
              </Button>
            </div>
          </Card>

          <Card className="rounded-md p-4">
            <label className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Refinement notes</label>
            <textarea
              className="mt-2 min-h-24 w-full rounded-md border border-[var(--border-light)] bg-white p-3 text-sm text-[var(--text)] outline-none focus:border-orange-400"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="Optional: change the cadence, add an approval rule, prefer Telegram, or make the output more concise."
            />
          </Card>

          {proposal ? (
            <Card className="rounded-md p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                    {proposal.templateId.replace(/_/g, " ")}
                  </div>
                  <h2 className="mt-1 text-lg font-semibold text-[var(--text)]">{proposal.title}</h2>
                  <p className="mt-1 text-sm text-[var(--text-2)]">{proposal.summary}</p>
                </div>
                <div className="rounded-md border border-[var(--border-light)] px-2 py-1 text-xs text-[var(--text-muted)]">
                  {stages.length} stages
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {stages.map((stage, index) => (
                  <div key={stage.id} className="rounded-md border border-[var(--border-light)] bg-[var(--muted)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-[var(--text)]">
                        {index + 1}. {stage.name ?? stage.label ?? stage.id}
                      </div>
                      <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{stage.kind}</div>
                    </div>
                    {stage.task ? <p className="mt-2 text-sm text-[var(--text-2)]">{stage.task}</p> : null}
                    {stage.toolRef ? <p className="mt-2 text-xs text-[var(--text-muted)]">Tool: {stage.toolRef}</p> : null}
                    {stage.approvalPolicy?.channels?.length ? (
                      <p className="mt-2 text-xs text-[var(--text-muted)]">
                        Approval: {stage.approvalPolicy.channels.join(", ")}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </section>

        <aside className="space-y-4">
          <Card className="rounded-md p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
              <Check size={15} />
              Builder context
            </div>
            {proposal ? (
              <div className="space-y-4">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Tools</div>
                  <p className="mt-1 text-sm text-[var(--text-2)]">
                    {proposal.suggestedToolRefs.length ? proposal.suggestedToolRefs.join(", ") : "No tools suggested"}
                  </p>
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Channels</div>
                  <p className="mt-1 text-sm text-[var(--text-2)]">{proposal.suggestedChannels.join(", ")}</p>
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Rationale</div>
                  <div className="mt-2 space-y-2">
                    {proposal.rationale.map((line, index) => (
                      <p key={index} className="text-sm text-[var(--text-2)]">{line}</p>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-[var(--text-2)]">Generate a proposal to see memory, preferences, tools, and approval routing.</p>
            )}
          </Card>

          {proposal ? (
            <>
              <Card className="rounded-md p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Memory</div>
                <div className="mt-2 space-y-2">
                  {proposal.memories.length === 0 ? (
                    <p className="text-sm text-[var(--text-2)]">No relevant memories found.</p>
                  ) : proposal.memories.map((memory) => (
                    <p key={memory.id} className="text-sm text-[var(--text-2)]">{memory.text}</p>
                  ))}
                </div>
              </Card>

              <Card className="rounded-md p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Preferences</div>
                <div className="mt-2 space-y-2">
                  {proposal.preferences.length === 0 ? (
                    <p className="text-sm text-[var(--text-2)]">No saved preferences found.</p>
                  ) : proposal.preferences.map((preference) => (
                    <p key={preference.id} className="text-sm text-[var(--text-2)]">{preference.text}</p>
                  ))}
                </div>
              </Card>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
