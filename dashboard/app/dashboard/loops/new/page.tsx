"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, FileText, Loader2, RefreshCw, Save, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type IntentChoice = {
  id: string;
  label: string;
  value: string;
  impact: string;
};

type IntentQuestion = {
  id: string;
  question: string;
  reason: string;
  choices: IntentChoice[];
  recommendedChoiceId: string;
};

type IntentAnalysis = {
  normalizedIntent: {
    outcome: string;
    toolCategories: string[];
    cadence: string;
    approvalModel: string;
    runtimeInputs: string[];
  };
  questions: IntentQuestion[];
  assumptions: string[];
};

type IntentContext = {
  decisions: Array<{
    questionId: string;
    question: string;
    answer: string;
    source: "user" | "recommended_assumption";
  }>;
  assumptions: string[];
  resolvedIntent: string;
};

type IntentAnswerDraft = {
  choiceId?: string;
  freeText?: string;
};

type LoopSpec = {
  id: string;
  title: string;
  status: "draft" | "approved" | "archived";
  version: number;
  sourcePrompt: string;
  bodyMarkdown: string;
  specJson?: {
    delivery?: { provider: string; description?: string };
    connectorPolicy?: {
      allowedReadActions?: Array<{ toolkit: string; actionSlug: string; risk: string }>;
      allowedWriteActions?: Array<{ toolkit: string; actionSlug: string; risk: string; requiresPreSendApproval?: boolean }>;
    };
    inputRequirements?: Array<{ key: string; surface: string; label: string }>;
  };
  intentContext?: IntentContext;
  approvedAt: string | null;
};

type ConnectorAccount = { id: string; appKey: string | null; status: string };
type ConnectorTool = { toolkit: string; actionSlug: string; name: string; risk: "read" | "write" | "send" | "destructive" };

type AgentGraphChild = {
  id: string;
  name: string;
  task: string;
  tools?: Array<{ ref: string }>;
};

type BuilderProposal = {
  title: string;
  summary: string;
  definition: {
    goal: string;
    schedule: { cron: string; timezone: string };
    allowedToolRefs?: string[];
    operatorInteractionPlan?: {
      version: "v1";
      interactions: Array<{
        id: string;
        kind: "collect_input" | "review_artifact" | "confirm_action" | "connect_connector";
        label?: string;
        surface?: string;
        artifactId?: string;
        rendererRef?: string | null;
        contractRef?: string;
      }>;
    };
    agentGraph?: {
      parent?: { name: string; task: string; policy: string };
      children?: AgentGraphChild[];
    };
    builderMeta?: {
      model?: string;
      noSlopSpec?: { id: string; title: string; version: number; approvedAt: string };
      designDiagnostics?: Record<string, unknown>;
    };
  };
  suggestedChannels: string[];
  suggestedToolRefs: string[];
  memories: Array<{ id: string; text: string }>;
  preferences: Array<{ id: string; text: string; category?: string | null }>;
  rationale: string[];
  designedBy?: string;
  model?: string;
  noSlopSpec?: { id: string; title: string; version: number; approvedAt: string };
  trace?: { stages?: Array<Record<string, unknown>> };
};

type BuilderProgress = {
  status?: string;
  kind?: string;
  events?: Array<{
    id: number;
    at: string;
    stage: string;
    message: string;
    status: "running" | "completed" | "failed";
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    details?: unknown;
  }>;
  usage?: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    models: Record<string, number>;
  };
};

const BUILDER_POLL_INTERVAL_MS = 2000;
const BUILDER_POLL_MAX_ATTEMPTS = 150;
const SPEC_POLL_INTERVAL_MS = 3000;
const SPEC_POLL_MAX_ATTEMPTS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function readJson<T>(response: Response): Promise<T & { error?: string; details?: Array<{ message?: string }> }> {
  return response.json().catch(() => ({}));
}

async function pollLoopBuilderJob(jobId: string, onProgress: (progress: BuilderProgress) => void): Promise<BuilderProposal> {
  for (let attempt = 0; attempt < BUILDER_POLL_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`/api/loop-builder/jobs/${jobId}`, { cache: "no-store" });
    const payload = await readJson<BuilderProgress & { proposal?: BuilderProposal }>(response);
    if (!response.ok) throw new Error(payload.error ?? "Failed to check loop design status");
    onProgress(payload);
    if (payload.status === "completed" && payload.proposal) return payload.proposal;
    if (payload.status === "failed") throw new Error(payload.error ?? "Loop design failed");
    await sleep(BUILDER_POLL_INTERVAL_MS);
  }
  throw new Error("Loop design is still running. Try again in a moment.");
}

async function pollSpecJob(jobId: string, onProgress: (progress: BuilderProgress) => void): Promise<LoopSpec> {
  for (let attempt = 0; attempt < SPEC_POLL_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`/api/loop-builder/jobs/${jobId}`, { cache: "no-store" });
    const payload = await readJson<BuilderProgress & { spec?: LoopSpec }>(response);
    if (!response.ok) throw new Error(payload.error ?? "Failed to check spec status");
    onProgress(payload);
    if (payload.status === "completed" && payload.spec) return payload.spec;
    if (payload.status === "failed") throw new Error(payload.error ?? "Spec generation failed");
    await sleep(SPEC_POLL_INTERVAL_MS);
  }
  throw new Error("Spec generation is still running. Try again in a moment.");
}

async function pollIntentAnalysisJob(jobId: string, onProgress: (progress: BuilderProgress) => void): Promise<IntentAnalysis> {
  for (let attempt = 0; attempt < SPEC_POLL_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`/api/loop-builder/jobs/${jobId}`, { cache: "no-store" });
    const payload = await readJson<BuilderProgress & { intentAnalysis?: IntentAnalysis }>(response);
    if (!response.ok) throw new Error(payload.error ?? "Failed to check intent analysis status");
    onProgress(payload);
    if (payload.status === "completed" && payload.intentAnalysis) return payload.intentAnalysis;
    if (payload.status === "failed") throw new Error(payload.error ?? "Intent analysis failed");
    await sleep(BUILDER_POLL_INTERVAL_MS);
  }
  throw new Error("Intent analysis is still running. Try again in a moment.");
}

function detailMessage(payload: { error?: string; details?: Array<{ message?: string }> }, fallback: string): string {
  const detail = payload.details?.[0]?.message;
  return detail ? `${payload.error ?? fallback}: ${detail}` : (payload.error ?? fallback);
}

export default function NewLoopBuilderPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [feedback, setFeedback] = useState("");
  const [spec, setSpec] = useState<LoopSpec | null>(null);
  const [specMarkdown, setSpecMarkdown] = useState("");
  const [specCode, setSpecCode] = useState("");
  const [proposal, setProposal] = useState<BuilderProposal | null>(null);
  const [busy, setBusy] = useState<"draft" | "refine" | "approve" | "generate" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<ConnectorAccount[]>([]);
  const [connectorTools, setConnectorTools] = useState<Record<string, ConnectorTool[]>>({});
  const [intentAnalysis, setIntentAnalysis] = useState<IntentAnalysis | null>(null);
  const [intentAnalysisJobId, setIntentAnalysisJobId] = useState<string | null>(null);
  const [intentAnswers, setIntentAnswers] = useState<Record<string, IntentAnswerDraft>>({});
  const [clarificationOpen, setClarificationOpen] = useState(false);
  const [analysisFallback, setAnalysisFallback] = useState<string | null>(null);
  const [builderProgress, setBuilderProgress] = useState<BuilderProgress | null>(null);

  const agents = useMemo(() => proposal?.definition.agentGraph?.children ?? [], [proposal]);
  const designDiagnostics = proposal?.definition.builderMeta?.designDiagnostics ?? null;
  const architectTrace = proposal?.trace ?? designDiagnostics?.trace ?? null;
  const approved = spec?.status === "approved";
  const connectedKeys = useMemo(() => {
    return [...new Set(
      connectors
        .filter((connector) => connector.status === "connected")
        .map((connector) => (connector.appKey ?? "").trim().toLowerCase())
        .filter(Boolean),
    )];
  }, [connectors]);
  const delivery = spec?.specJson?.delivery;
  const connectorPolicy = spec?.specJson?.connectorPolicy;
  const hasOutboundDelivery = Boolean(delivery?.provider && delivery.provider.toLowerCase() !== "none");
  const writeActions = connectorPolicy?.allowedWriteActions ?? [];

  useEffect(() => {
    async function loadConnectors() {
      try {
        const response = await fetch("/api/connectors", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        setConnectors(Array.isArray(payload.connectors) ? payload.connectors : []);
      } catch {
        setConnectors([]);
      }
    }
    void loadConnectors();
  }, []);

  useEffect(() => {
    async function loadTools() {
      const next: Record<string, ConnectorTool[]> = {};
      for (const toolkit of connectedKeys.slice(0, 12)) {
        try {
          const response = await fetch(`/api/connectors/composio/toolkits/${encodeURIComponent(toolkit)}/tools`, { cache: "no-store" });
          const payload = await response.json().catch(() => ({}));
          next[toolkit] = Array.isArray(payload.tools) ? payload.tools.slice(0, 12) : [];
        } catch {
          next[toolkit] = [];
        }
      }
      setConnectorTools(next);
    }
    void loadTools();
  }, [connectedKeys]);

  async function submitSpecDraft(input?: {
    analysisJobId?: string;
    answers?: Array<{ questionId: string; choiceId?: string; freeText?: string }>;
    skippedQuestionIds?: string[];
  }) {
    setBusy("draft");
    setError(null);
    setProposal(null);
    try {
      const response = await fetch("/api/loop-builder/specs/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          ...(input?.analysisJobId ? { intentAnalysisJobId: input.analysisJobId } : {}),
          ...(input?.answers?.length ? { answers: input.answers } : {}),
          ...(input?.skippedQuestionIds?.length ? { skippedQuestionIds: input.skippedQuestionIds } : {}),
        }),
      });
      const payload = await readJson<{ jobId?: string; spec?: LoopSpec }>(response);
      if (!response.ok) throw new Error(detailMessage(payload, "Failed to draft spec"));
      let resultSpec: LoopSpec;
      if (payload.jobId) {
        resultSpec = await pollSpecJob(payload.jobId, setBuilderProgress);
      } else if (payload.spec) {
        resultSpec = payload.spec;
      } else {
        throw new Error("Spec draft returned no job id or spec");
      }
      setSpec(resultSpec);
      setSpecMarkdown(resultSpec.bodyMarkdown);
      setSpecCode(JSON.stringify(resultSpec.specJson ?? {}, null, 2));
      setFeedback("");
      setClarificationOpen(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to draft spec");
    } finally {
      setBusy(null);
    }
  }

  async function draftSpec() {
    setBusy("draft");
    setError(null);
    setProposal(null);
    setBuilderProgress(null);
    setAnalysisFallback(null);
    let analysisJobId: string | null = null;
    try {
      const response = await fetch("/api/loop-builder/intent/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const payload = await readJson<{ jobId?: string }>(response);
      if (!response.ok || !payload.jobId) throw new Error(detailMessage(payload, "Failed to analyze intent"));
      analysisJobId = payload.jobId;
      const analysis = await pollIntentAnalysisJob(payload.jobId, setBuilderProgress);
      setIntentAnalysis(analysis);
      setIntentAnalysisJobId(payload.jobId);
      setIntentAnswers({});
      if (analysis.questions.length > 0) {
        setClarificationOpen(true);
        setBusy(null);
        return;
      }
    } catch {
      setAnalysisFallback("Intent analysis was unavailable. The spec was drafted from the original request using the clearest available assumptions.");
      await submitSpecDraft();
      return;
    }
    await submitSpecDraft({ analysisJobId: analysisJobId! });
  }

  async function draftWithClarifications(useRecommendedOnly = false) {
    if (!intentAnalysis || !intentAnalysisJobId) return;
    const answers = useRecommendedOnly
      ? []
      : intentAnalysis.questions.flatMap((question) => {
          const answer = intentAnswers[question.id];
          if (!answer?.choiceId && !answer?.freeText?.trim()) return [];
          return [{
            questionId: question.id,
            ...(answer.choiceId ? { choiceId: answer.choiceId } : {}),
            ...(answer.freeText?.trim() ? { freeText: answer.freeText.trim() } : {}),
          }];
        });
    const answeredIds = new Set(answers.map((answer) => answer.questionId));
    const skippedQuestionIds = intentAnalysis.questions
      .filter((question) => useRecommendedOnly || !answeredIds.has(question.id))
      .map((question) => question.id);
    await submitSpecDraft({
      analysisJobId: intentAnalysisJobId,
      answers,
      skippedQuestionIds,
    });
  }

  async function refineSpec() {
    if (!spec) return;
    setBusy("refine");
    setError(null);
    setProposal(null);
    setBuilderProgress(null);
    try {
      const response = await fetch(`/api/loop-builder/specs/${spec.id}/refine`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
      const payload = await readJson<{ jobId?: string; spec?: LoopSpec }>(response);
      if (!response.ok) throw new Error(detailMessage(payload, "Failed to refine spec"));
      let resultSpec: LoopSpec;
      if (payload.jobId) {
        resultSpec = await pollSpecJob(payload.jobId, setBuilderProgress);
      } else if (payload.spec) {
        resultSpec = payload.spec;
      } else {
        throw new Error("Spec refine returned no job id or spec");
      }
      setSpec(resultSpec);
      setSpecMarkdown(resultSpec.bodyMarkdown);
      setSpecCode(JSON.stringify(resultSpec.specJson ?? {}, null, 2));
      setFeedback("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to refine spec");
    } finally {
      setBusy(null);
    }
  }

  async function approveSpec() {
    if (!spec) return;
    setBusy("approve");
    setError(null);
    setProposal(null);
    try {
      const parsedSpecJson = specCode.trim() ? JSON.parse(specCode) : undefined;
      const response = await fetch(`/api/loop-builder/specs/${spec.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bodyMarkdown: specMarkdown, specJson: parsedSpecJson }),
      });
      const payload = await readJson<{ spec?: LoopSpec }>(response);
      if (!response.ok || !payload.spec) throw new Error(detailMessage(payload, "Failed to approve spec"));
      setSpec(payload.spec);
      setSpecMarkdown(payload.spec.bodyMarkdown);
      setSpecCode(JSON.stringify(payload.spec.specJson ?? parsedSpecJson ?? {}, null, 2));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to approve spec");
    } finally {
      setBusy(null);
    }
  }

  async function generateProposal() {
    if (!spec) return;
    setBusy("generate");
    setError(null);
    setBuilderProgress(null);
    try {
      const response = await fetch(`/api/loop-builder/specs/${spec.id}/generate`, { method: "POST" });
      const payload = await readJson<{ jobId?: string; proposal?: BuilderProposal }>(response);
      if (!response.ok) throw new Error(detailMessage(payload, "Failed to generate loop"));
      if (payload.jobId) {
        setProposal(await pollLoopBuilderJob(payload.jobId, setBuilderProgress));
      } else if (payload.proposal) {
        setProposal(payload.proposal);
      } else {
        throw new Error("Loop builder returned no job id or proposal");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to generate loop");
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
      const payload = await readJson<{ loop?: { id: string } }>(response);
      if (!response.ok) throw new Error(detailMessage(payload, "Failed to save loop"));
      const workflowId = payload.loop?.id;
      if (!workflowId) throw new Error("Loop saved but no workflow id was returned");
      router.push(`/dashboard/loops/${workflowId}`);
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
          <p className="mt-1 text-sm text-[var(--text-2)]">
            Draft and approve the loop spec first. Tallei generates agents only after that behavioral contract is approved.
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
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">{error}</pre>
        </div>
      ) : null}
      {analysisFallback ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {analysisFallback}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="space-y-4">
          <Card className="rounded-md p-4">
            <label className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">What should repeat?</label>
            <textarea
              className="mt-2 min-h-36 w-full rounded-md border border-[var(--border-light)] bg-white p-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(126,183,27,.18)]"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={Boolean(spec)}
              placeholder="Example: Every Friday, research what's new in AI tooling, draft a product essay in my voice from memory, and hold it for review."
            />
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" className="h-9 gap-1.5" disabled={!prompt.trim() || busy !== null || Boolean(spec)} onClick={() => void draftSpec()}>
                {busy === "draft" ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                {busy === "draft" ? "Drafting spec..." : "Draft spec"}
              </Button>
              {spec ? (
                <Button type="button" variant="outline" className="h-9" disabled={busy !== null} onClick={() => {
                  setSpec(null);
                  setSpecMarkdown("");
                  setSpecCode("");
                  setProposal(null);
                  setFeedback("");
                  setIntentAnalysis(null);
                  setIntentAnalysisJobId(null);
                  setIntentAnswers({});
                  setAnalysisFallback(null);
                  setBuilderProgress(null);
                }}>
                  Start over
                </Button>
              ) : null}
            </div>
          </Card>

          {spec ? (
            <Card className="rounded-md p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">No-slop spec</div>
                  <h2 className="mt-1 text-lg font-semibold text-[var(--text)]">{spec.title}</h2>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">Version {spec.version}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${approved ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                    {approved ? "Approved" : "Needs approval"}
                  </span>
                  {hasOutboundDelivery ? (
                    <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
                      Outbound · {delivery?.provider}
                    </span>
                  ) : (
                    <span className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
                      Dashboard only
                    </span>
                  )}
                </div>
              </div>
              <textarea
                className="mt-4 min-h-96 w-full rounded-md border border-[var(--border-light)] bg-white p-3 font-mono text-xs leading-5 text-[var(--text)] outline-none focus:border-[var(--accent)]"
                value={specMarkdown}
                onChange={(event) => {
                  setSpecMarkdown(event.target.value);
                  setProposal(null);
                }}
                disabled={approved || busy !== null}
              />
              <div className="mt-4">
                <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Code spec</div>
                <textarea
                  className="mt-2 min-h-80 w-full rounded-md border border-[var(--border-light)] bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-100 outline-none focus:border-[var(--accent)]"
                  value={specCode}
                  onChange={(event) => {
                    setSpecCode(event.target.value);
                    setProposal(null);
                  }}
                  disabled={approved || busy !== null}
                />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button type="button" className="h-9 gap-1.5" disabled={approved || !specMarkdown.trim() || busy !== null} onClick={() => void approveSpec()}>
                  {busy === "approve" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {busy === "approve" ? "Approving..." : "Approve spec"}
                </Button>
                <Button type="button" variant="outline" className="h-9 gap-1.5" disabled={!approved || busy !== null} onClick={() => void generateProposal()}>
                  {busy === "generate" ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                  {busy === "generate" ? "Generating agents..." : "Generate agents"}
                </Button>
                <Button type="button" variant="outline" className="h-9 gap-1.5" disabled={!proposal || busy !== null} onClick={() => void saveProposal()}>
                  {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {busy === "save" ? "Saving..." : "Save & open"}
                </Button>
              </div>
            </Card>
          ) : null}

          {spec?.intentContext ? (
            <Card className="rounded-md border-l-4 border-l-sky-500 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Intent decisions and assumptions</div>
              <div className="mt-3 space-y-3">
                {spec.intentContext.decisions.map((decision) => (
                  <div key={decision.questionId} className="rounded-md border border-[var(--border-light)] bg-[var(--muted)] p-3">
                    <div className="text-sm font-medium text-[var(--text)]">{decision.question}</div>
                    <p className="mt-1 text-sm text-[var(--text-2)]">{decision.answer}</p>
                    <span className="mt-2 inline-block rounded bg-white px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                      {decision.source === "user" ? "Answered" : "Recommended assumption"}
                    </span>
                  </div>
                ))}
                {spec.intentContext.assumptions.map((assumption, index) => (
                  <p key={index} className="text-sm text-[var(--text-2)]">Assumption: {assumption}</p>
                ))}
              </div>
            </Card>
          ) : null}

          <Card className="rounded-md p-4">
            <label className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Spec refinement notes</label>
            <textarea
              className="mt-2 min-h-24 w-full rounded-md border border-[var(--border-light)] bg-white p-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              disabled={!spec || approved || busy !== null}
              placeholder="Before approval: tighten the success criteria, change the cadence, add a guardrail, etc."
            />
            <Button
              type="button"
              variant="outline"
              className="mt-3 h-9 gap-1.5"
              disabled={!spec || approved || !feedback.trim() || busy !== null}
              onClick={() => void refineSpec()}
            >
              {busy === "refine" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refine spec
            </Button>
          </Card>

          {proposal ? (
            <Card className="rounded-md p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Generated agent spec</div>
                  <h2 className="mt-2 text-lg font-semibold text-[var(--text)]">{proposal.title}</h2>
                  <p className="mt-1 text-sm text-[var(--text-2)]">{proposal.summary}</p>
                </div>
                <div className="rounded-md border border-[var(--border-light)] px-2 py-1 text-xs text-[var(--text-muted)]">
                  {agents.length} agents
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {agents.map((agent, index) => (
                  <div key={agent.id} className="rounded-md border border-[var(--border-light)] bg-[var(--muted)] p-3">
                    <div className="text-sm font-medium text-[var(--text)]">{index + 1}. {agent.name}</div>
                    <p className="mt-2 text-sm text-[var(--text-2)]">{agent.task}</p>
                    {agent.tools?.length ? (
                      <p className="mt-2 text-xs text-[var(--text-muted)]">Tools: {agent.tools.map((tool) => tool.ref).join(", ")}</p>
                    ) : null}
                  </div>
                ))}
              </div>

              <div className="mt-5">
                <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Code spec</div>
                <pre className="mt-2 max-h-[520px] overflow-auto rounded-md border border-[var(--border-light)] bg-slate-950 p-3 text-xs leading-5 text-slate-100">
                  {JSON.stringify(proposal.definition, null, 2)}
                </pre>
              </div>

              {designDiagnostics ? (
                <div className="mt-5">
                  <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Agent generation output</div>
                  <pre className="mt-2 max-h-[420px] overflow-auto rounded-md border border-[var(--border-light)] bg-slate-950 p-3 text-xs leading-5 text-slate-100">
                    {JSON.stringify(designDiagnostics, null, 2)}
                  </pre>
                </div>
              ) : null}

              {architectTrace ? (
                <div className="mt-5">
                  <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Generation trace</div>
                  <pre className="mt-2 max-h-[320px] overflow-auto rounded-md border border-[var(--border-light)] bg-slate-950 p-3 text-xs leading-5 text-slate-100">
                    {JSON.stringify(architectTrace, null, 2)}
                  </pre>
                </div>
              ) : null}
            </Card>
          ) : null}
        </section>

        <aside className="space-y-4">
          {builderProgress ? (
            <Card className="overflow-hidden rounded-md border-slate-300 bg-slate-950 text-slate-100">
              <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    {builderProgress.status === "running" || builderProgress.status === "pending"
                      ? <Loader2 size={14} className="animate-spin text-lime-400" />
                      : <Check size={14} className="text-lime-400" />}
                    Live builder log
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{builderProgress.kind ?? "builder"} · {builderProgress.status ?? "running"}</p>
                </div>
                <div className="text-right">
                  <div className="font-mono text-lg font-semibold text-lime-300">
                    ${(builderProgress.usage?.estimatedCostUsd ?? 0).toFixed(6)}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">estimated cost</div>
                </div>
              </div>
              <div className="grid grid-cols-3 border-b border-slate-800 text-center">
                <div className="px-2 py-2">
                  <div className="font-mono text-sm">{builderProgress.usage?.calls ?? 0}</div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">AI calls</div>
                </div>
                <div className="border-x border-slate-800 px-2 py-2">
                  <div className="font-mono text-sm">{(builderProgress.usage?.promptTokens ?? 0).toLocaleString()}</div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Input tokens</div>
                </div>
                <div className="px-2 py-2">
                  <div className="font-mono text-sm">{(builderProgress.usage?.completionTokens ?? 0).toLocaleString()}</div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Output tokens</div>
                </div>
              </div>
              <div className="max-h-[680px] space-y-3 overflow-y-auto px-4 py-3 font-mono text-xs">
                {(builderProgress.events ?? []).length > 0 ? (builderProgress.events ?? []).map((event) => (
                  <div key={event.id} className="border-l border-slate-700 pl-3">
                    <div className="flex justify-between gap-3 text-slate-500">
                      <span>{new Date(event.at).toLocaleTimeString()}</span>
                      <span>{event.stage}</span>
                    </div>
                    <div className={event.status === "failed" ? "mt-1 text-red-300" : "mt-1 text-slate-200"}>{event.message}</div>
                    {event.model ? (
                      <div className="mt-1 text-slate-500">
                        {event.model} · {(event.totalTokens ?? 0).toLocaleString()} tokens · ${(event.estimatedCostUsd ?? 0).toFixed(6)}
                      </div>
                    ) : null}
                    {event.details !== undefined ? (
                      <details className="mt-2 rounded border border-slate-800 bg-black/30">
                        <summary className="cursor-pointer select-none px-2 py-1.5 text-[11px] uppercase tracking-wide text-slate-400 hover:text-slate-200">
                          Detailed process data
                        </summary>
                        <pre className="max-h-96 overflow-auto border-t border-slate-800 p-2 text-[11px] leading-5 text-slate-300">
                          {JSON.stringify(event.details, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                )) : <p className="text-slate-500">Waiting for the first builder event...</p>}
              </div>
            </Card>
          ) : null}

          <Card className="rounded-md p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
              <Check size={15} />
              Builder state
            </div>
            <div className="space-y-3 text-sm text-[var(--text-2)]">
              <p>1. Analyze the request and clarify only decisions that materially change the loop.</p>
              <p>2. Refine or edit the spec until it captures the behavior you want.</p>
              <p>3. Approve the spec, generate agents, then save the loop.</p>
            </div>
          </Card>

          <Card className="rounded-md p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Connected app capabilities</div>
            {connectedKeys.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--text-2)]">No connected apps available for this loop.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {connectedKeys.map((toolkit) => (
                  <div key={toolkit} className="rounded-md border border-[var(--border-light)] p-3">
                    <div className="text-sm font-medium text-[var(--text)]">{toolkit}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(connectorTools[toolkit] ?? []).slice(0, 8).map((tool) => (
                        <span key={tool.actionSlug} className={`rounded px-1.5 py-0.5 text-[11px] ${tool.risk === "read" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                          {tool.name || tool.actionSlug} · {tool.risk}
                        </span>
                      ))}
                      {(connectorTools[toolkit] ?? []).length === 0 ? (
                        <span className="text-xs text-[var(--text-muted)]">Search is available; action discovery returned no tools.</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {spec ? (
              <div className="mt-4 rounded-md border border-[var(--border-light)] bg-[var(--muted)] p-3 text-xs text-[var(--text-2)]">
                <div className="font-medium text-[var(--text)]">Delivery</div>
                {hasOutboundDelivery ? (
                  <>
                    <p className="mt-1">Provider: <span className="font-medium text-[var(--text)]">{delivery?.provider}</span></p>
                    {delivery?.description ? <p className="mt-1">{delivery.description}</p> : null}
                    <p className="mt-2">
                      Send actions:{" "}
                      {writeActions.length > 0
                        ? writeActions.map((action) => `${action.toolkit}/${action.actionSlug}`).join(", ")
                        : approved
                          ? "none"
                          : "bound from Connected Apps when you approve"}
                    </p>
                  </>
                ) : (
                  <p className="mt-1">No outbound delivery — artifacts stay in the dashboard.</p>
                )}
              </div>
            ) : null}
          </Card>

          {proposal ? (
            <>
              <Card className="rounded-md p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Schedule</div>
                <p className="mt-1 text-sm text-[var(--text-2)]">
                  {proposal.definition.schedule.cron} ({proposal.definition.schedule.timezone})
                </p>
                <div className="mt-4 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Tools</div>
                <p className="mt-1 text-sm text-[var(--text-2)]">
                  {proposal.suggestedToolRefs.length ? proposal.suggestedToolRefs.join(", ") : "No tools suggested"}
                </p>
              </Card>

              <Card className="rounded-md p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Operator interactions</div>
                <div className="mt-3 space-y-2">
                  {(proposal.definition.operatorInteractionPlan?.interactions ?? []).map((interaction) => (
                    <div key={interaction.id} className="rounded-md border border-[var(--border-light)] bg-[var(--muted)] p-3">
                      <div className="text-sm font-medium text-[var(--text)]">{interaction.kind.replace(/_/g, " ")}</div>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        {interaction.label
                          ?? interaction.artifactId
                          ?? interaction.contractRef
                          ?? interaction.surface
                          ?? interaction.id}
                      </p>
                    </div>
                  ))}
                  {(proposal.definition.operatorInteractionPlan?.interactions ?? []).length === 0 ? (
                    <p className="text-sm text-[var(--text-2)]">No operator interaction is required during this workflow.</p>
                  ) : null}
                </div>
              </Card>

              <Card className="rounded-md p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Rationale</div>
                <div className="mt-2 space-y-2">
                  {proposal.rationale.map((line, index) => (
                    <p key={index} className="text-sm text-[var(--text-2)]">{line}</p>
                  ))}
                </div>
              </Card>
            </>
          ) : null}
        </aside>
      </div>

      <Dialog open={clarificationOpen} onOpenChange={(open) => {
        setClarificationOpen(open);
        if (!open) setBusy(null);
      }}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Clarify the loop intent</DialogTitle>
            <DialogDescription>
              These optional decisions materially change the workflow. Unanswered questions use the marked recommendation.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {intentAnalysis?.questions.map((question, questionIndex) => (
              <section key={question.id} className="rounded-lg border border-[var(--border-light)] p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Decision {questionIndex + 1}</div>
                <h3 className="mt-1 text-base font-semibold text-[var(--text)]">{question.question}</h3>
                <p className="mt-1 text-sm text-[var(--text-2)]">{question.reason}</p>
                <div className="mt-3 grid gap-2">
                  {question.choices.map((choice) => {
                    const selected = intentAnswers[question.id]?.choiceId === choice.id;
                    const recommended = question.recommendedChoiceId === choice.id;
                    return (
                      <button
                        key={choice.id}
                        type="button"
                        className={`rounded-md border p-3 text-left transition-colors ${
                          selected
                            ? "border-sky-500 bg-sky-50"
                            : "border-[var(--border-light)] bg-white hover:border-sky-300"
                        }`}
                        onClick={() => setIntentAnswers((current) => ({
                          ...current,
                          [question.id]: { ...current[question.id], choiceId: choice.id },
                        }))}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-[var(--text)]">{choice.label}</span>
                          {recommended ? <span className="rounded bg-green-50 px-1.5 py-0.5 text-[11px] font-medium text-green-700">Recommended</span> : null}
                        </div>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">{choice.impact}</p>
                      </button>
                    );
                  })}
                </div>
                <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Optional custom answer
                </label>
                <input
                  className="mt-1 h-10 w-full rounded-md border border-[var(--border-light)] bg-white px-3 text-sm outline-none focus:border-sky-500"
                  value={intentAnswers[question.id]?.freeText ?? ""}
                  onChange={(event) => setIntentAnswers((current) => ({
                    ...current,
                    [question.id]: { ...current[question.id], freeText: event.target.value },
                  }))}
                  placeholder="Override the suggested answers"
                />
              </section>
            ))}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void draftWithClarifications(true)}>
              Use recommended assumptions
            </Button>
            <Button type="button" disabled={busy !== null} onClick={() => void draftWithClarifications(false)}>
              {busy === "draft" ? <Loader2 size={14} className="animate-spin" /> : null}
              Draft with answers
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
