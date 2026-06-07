"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, ChevronDown, ChevronUp, Loader2, RefreshCw, Save, Sparkles, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type TemplateHint = "writing_companion" | "newsletter_broadcast" | "custom";

type AgentGraphChild = {
  id: string;
  name: string;
  task: string;
  tools?: Array<{ ref: string }>;
};

type BuilderProposal = {
  title: string;
  summary: string;
  templateId: TemplateHint;
  definition: {
    goal: string;
    schedule: { cron: string; timezone: string };
    allowedToolRefs?: string[];
    agentGraph?: {
      parent?: { name: string; task: string; policy: string };
      children?: AgentGraphChild[];
    };
    builderMeta?: {
      preApproved?: boolean;
      model?: string;
    };
  };
  suggestedChannels: string[];
  suggestedToolRefs: string[];
  memories: Array<{ id: string; text: string }>;
  preferences: Array<{ id: string; text: string; category?: string | null }>;
  rationale: string[];
  designedBy?: string;
  model?: string;
};

const BUILDER_POLL_INTERVAL_MS = 2000;
const BUILDER_POLL_MAX_ATTEMPTS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function pollLoopBuilderJob(jobId: string): Promise<BuilderProposal> {
  for (let attempt = 0; attempt < BUILDER_POLL_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`/api/loop-builder/jobs/${jobId}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as {
      error?: string;
      status?: string;
      proposal?: BuilderProposal;
    };
    if (!response.ok) {
      throw new Error(payload.error ?? "Failed to check loop design status");
    }
    if (payload.status === "completed" && payload.proposal) {
      return payload.proposal;
    }
    if (payload.status === "failed") {
      throw new Error(payload.error ?? "Loop design failed");
    }
    await sleep(BUILDER_POLL_INTERVAL_MS);
  }
  throw new Error("Loop design is still running. Try again in a moment.");
}

const inspirationTemplates: Array<{ id: Exclude<TemplateHint, "custom">; label: string; hint: string }> = [
  {
    id: "writing_companion",
    label: "Writing companion",
    hint: "Use the writing companion pattern: memory search, source research, brief, writer, approval handoff.",
  },
  {
    id: "newsletter_broadcast",
    label: "Newsletter broadcast",
    hint: "Use the newsletter broadcast pattern with subscriber email delivery and broadcast after approval.",
  },
];

export default function NewLoopBuilderPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [feedback, setFeedback] = useState("");
  const [templateHint, setTemplateHint] = useState<TemplateHint>("custom");
  const [inspirationOpen, setInspirationOpen] = useState(false);
  const [proposal, setProposal] = useState<BuilderProposal | null>(null);
  const [busy, setBusy] = useState<"propose" | "refine" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agents = useMemo(
    () => proposal?.definition.agentGraph?.children ?? [],
    [proposal],
  );

  async function requestProposal(mode: "propose" | "refine") {
    setBusy(mode);
    setError(null);
    try {
      const response = await fetch(`/api/loop-builder/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          templateId: templateHint === "custom" ? undefined : templateHint,
          feedback: mode === "refine" ? (feedback.trim() || prompt) : undefined,
          priorProposal: mode === "refine" ? proposal : undefined,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        details?: Array<{ message?: string }>;
        jobId?: string;
        proposal?: BuilderProposal;
      };
      if (!response.ok) {
        const detail = Array.isArray(payload.details) && payload.details[0] && typeof payload.details[0] === "object"
          ? payload.details[0].message
          : undefined;
        throw new Error(
          detail ? `${payload.error ?? `Failed to ${mode} loop`}: ${detail}` : (payload.error ?? `Failed to ${mode} loop`),
        );
      }
      if (payload.jobId) {
        setProposal(await pollLoopBuilderJob(payload.jobId));
      } else if (payload.proposal) {
        setProposal(payload.proposal);
      } else {
        throw new Error("Loop builder returned no job id or proposal");
      }
      if (mode === "refine") setFeedback("");
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
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        details?: Array<{ message?: string }>;
        loop?: { id: string };
      };
      if (!response.ok) {
        const detail = payload.details?.[0]?.message;
        throw new Error(
          detail ? `${payload.error ?? "Failed to save loop"}: ${detail}` : (payload.error ?? "Failed to save loop"),
        );
      }

      const workflowId = payload.loop?.id;
      if (!workflowId) throw new Error("Loop saved but no workflow id was returned");
      router.push(`/dashboard/loops/${workflowId}`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save loop");
    } finally {
      setBusy(null);
    }
  }

  function appendInspirationHint(hint: string) {
    setPrompt((current) => (current.trim() ? `${current.trim()}\n\n${hint}` : hint));
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
          <p className="mt-1 text-sm text-[var(--text-2)]">
            Describe what you want to repeat. The CEO agent designs a bespoke agent loop from your intent and memory.
          </p>
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
              className="mt-2 min-h-44 w-full rounded-md border border-[var(--border-light)] bg-white p-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(126,183,27,.18)]"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Example: Every Friday, research what's new in AI tooling, draft a product essay in my voice from memory, and send it to me for approval before publishing."
            />

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                className="h-9 gap-1.5"
                disabled={!prompt.trim() || busy !== null}
                onClick={() => void requestProposal("propose")}
              >
                {busy === "propose" ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                {busy === "propose" ? "Designing loop…" : "Design loop"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-9 gap-1.5"
                disabled={!proposal || !feedback.trim() || busy !== null}
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
                {busy === "save" ? "Saving…" : "Save & open"}
              </Button>
            </div>
          </Card>

          <Card className="rounded-md p-4">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-left"
              onClick={() => setInspirationOpen((open) => !open)}
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
                <Sparkles size={15} />
                Inspiration (optional)
              </span>
              {inspirationOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {inspirationOpen ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-[var(--text-muted)]">
                  High-potential patterns the CEO can borrow. Click to add a hint to your prompt — the LLM still designs a custom loop.
                </p>
                {inspirationTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={`w-full rounded-md border p-3 text-left transition-colors ${
                      templateHint === template.id
                        ? "border-[var(--accent)] bg-[var(--accent-light)]"
                        : "border-[var(--border-light)] bg-white hover:border-[var(--border)]"
                    }`}
                    onClick={() => {
                      setTemplateHint(template.id);
                      appendInspirationHint(template.hint);
                    }}
                  >
                    <div className="text-sm font-medium text-[var(--text)]">{template.label}</div>
                    <div className="mt-1 text-xs text-[var(--text-muted)]">{template.hint}</div>
                  </button>
                ))}
              </div>
            ) : null}
          </Card>

          <Card className="rounded-md p-4">
            <label className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Refinement notes</label>
            <textarea
              className="mt-2 min-h-24 w-full rounded-md border border-[var(--border-light)] bg-white p-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="After proposing: make the writer more casual, add Telegram approval, run on Fridays, etc."
            />
          </Card>

          {proposal ? (
            <Card className="rounded-md p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    {proposal.definition.builderMeta?.preApproved !== false ? (
                      <span className="rounded-full bg-[var(--accent-light)] px-2 py-0.5 text-xs font-medium text-[var(--text-2)]">
                        Pre-approved
                      </span>
                    ) : null}
                    {proposal.model ? (
                      <span className="text-xs text-[var(--text-muted)]">Model: {proposal.model}</span>
                    ) : null}
                  </div>
                  <h2 className="mt-2 text-lg font-semibold text-[var(--text)]">{proposal.title}</h2>
                  <p className="mt-1 text-sm text-[var(--text-2)]">{proposal.summary}</p>
                </div>
                <div className="rounded-md border border-[var(--border-light)] px-2 py-1 text-xs text-[var(--text-muted)]">
                  {agents.length} agents
                </div>
              </div>

              {proposal.definition.agentGraph?.parent ? (
                <div className="mt-4 rounded-md border border-dashed border-[var(--border)] bg-[var(--muted)] p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Parent agent</div>
                  <div className="mt-1 text-sm font-medium text-[var(--text)]">{proposal.definition.agentGraph.parent.name}</div>
                  <p className="mt-1 text-sm text-[var(--text-2)]">{proposal.definition.agentGraph.parent.task}</p>
                </div>
              ) : null}

              <div className="mt-4 space-y-3">
                {agents.map((agent, index) => (
                  <div key={agent.id} className="rounded-md border border-[var(--border-light)] bg-[var(--muted)] p-3">
                    <div className="text-sm font-medium text-[var(--text)]">
                      {index + 1}. {agent.name}
                    </div>
                    <p className="mt-2 text-sm text-[var(--text-2)]">{agent.task}</p>
                    {agent.tools?.length ? (
                      <p className="mt-2 text-xs text-[var(--text-muted)]">
                        Tools: {agent.tools.map((tool) => tool.ref).join(", ")}
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
                  <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Schedule</div>
                  <p className="mt-1 text-sm text-[var(--text-2)]">
                    {proposal.definition.schedule.cron} ({proposal.definition.schedule.timezone})
                  </p>
                </div>
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
              <p className="text-sm text-[var(--text-2)]">
                Design a loop to see the CEO&apos;s agent roster, memory context, tools, and rationale. This usually takes a few seconds.
              </p>
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
