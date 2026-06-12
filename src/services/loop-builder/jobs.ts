import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import {
  refineLoopBuilderProposal,
  resolveLoopBuilderIntent,
  type LoopBuilderProposal,
  type LoopBuilderTemplateHint,
} from "./intent-resolver.js";
import { draftLoopSpec, refineLoopSpec, type LoopSpecView } from "./specs.js";
import {
  analyzeLoopBuilderIntent,
  resolveLoopIntentContext,
} from "./intent-analysis.js";
import type { LoopIntentAnalysis, LoopIntentAnswer, LoopIntentContext } from "../loop-engine/intent-context.js";
import {
  emptyLoopBuilderUsage,
  runWithLoopBuilderProgress,
  sanitizeLoopBuilderProgressDetails,
  type LoopBuilderProgressEvent,
  type LoopBuilderUsage,
} from "./progress.js";

export type LoopBuilderJobStatus = "pending" | "running" | "completed" | "failed";

export type LoopBuilderJobKind = "propose" | "refine" | "analyze-intent" | "draft-spec" | "refine-spec";

export interface LoopBuilderJobView {
  jobId: string;
  kind: LoopBuilderJobKind;
  status: LoopBuilderJobStatus;
  createdAt: string;
  updatedAt: string;
  proposal?: LoopBuilderProposal;
  spec?: LoopSpecView;
  intentAnalysis?: LoopIntentAnalysis;
  events: LoopBuilderProgressEvent[];
  usage: LoopBuilderUsage;
  error?: string;
}

interface LoopBuilderJobRecord extends LoopBuilderJobView {
  tenantId: string;
  userId: string;
}

const JOB_TTL_MS = 60 * 60_000;
const jobs = new Map<string, LoopBuilderJobRecord>();

function jobKey(auth: AuthContext, jobId: string): string {
  return `${auth.tenantId}:${auth.userId}:${jobId}`;
}

function pruneExpiredJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.updatedAt).getTime() < cutoff) {
      jobs.delete(id);
    }
  }
}

function toView(job: LoopBuilderJobRecord): LoopBuilderJobView {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    events: job.events,
    usage: job.usage,
    ...(job.proposal ? { proposal: job.proposal } : {}),
    ...(job.spec ? { spec: job.spec } : {}),
    ...(job.intentAnalysis ? { intentAnalysis: job.intentAnalysis } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function appendEvent(job: LoopBuilderJobRecord, event: Omit<LoopBuilderProgressEvent, "id" | "at">): void {
  const next = {
    ...event,
    ...(event.details !== undefined ? { details: sanitizeLoopBuilderProgressDetails(event.details) } : {}),
    id: (job.events.at(-1)?.id ?? 0) + 1,
    at: new Date().toISOString(),
  };
  job.events = [...job.events, next].slice(-100);
  if (event.model) job.usage.models[event.model] = (job.usage.models[event.model] ?? 0) + 1;
  if (event.promptTokens != null || event.completionTokens != null || event.totalTokens != null) {
    job.usage.calls += 1;
    job.usage.promptTokens += event.promptTokens ?? 0;
    job.usage.completionTokens += event.completionTokens ?? 0;
    job.usage.totalTokens += event.totalTokens ?? 0;
    job.usage.estimatedCostUsd = Number((job.usage.estimatedCostUsd + (event.estimatedCostUsd ?? 0)).toFixed(8));
  }
  job.updatedAt = next.at;
}

function progressRunner<T>(job: LoopBuilderJobRecord, runner: () => Promise<T>): Promise<T> {
  return runWithLoopBuilderProgress({ append: (event) => appendEvent(job, event) }, runner);
}

async function runIntentAnalysisJob(jobId: string, runner: () => Promise<LoopIntentAnalysis>): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "running";
  appendEvent(job, { stage: "intent_analysis", message: "Analyzing workflow intent and connector feasibility", status: "running" });
  try {
    job.intentAnalysis = await progressRunner(job, runner);
    job.status = "completed";
    appendEvent(job, { stage: "intent_analysis", message: "Intent analysis completed", status: "completed" });
    job.error = undefined;
  } catch (error) {
    job.status = "failed";
    appendEvent(job, { stage: "intent_analysis", message: "Intent analysis failed", status: "failed" });
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    job.updatedAt = new Date().toISOString();
  }
}

export function enqueueIntentAnalysisJob(input: { auth: AuthContext; prompt: string }): LoopBuilderJobView {
  pruneExpiredJobs();
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const record: LoopBuilderJobRecord = {
    jobId,
    kind: "analyze-intent",
    status: "pending",
    tenantId: input.auth.tenantId,
    userId: input.auth.userId,
    createdAt: now,
    updatedAt: now,
    events: [],
    usage: emptyLoopBuilderUsage(),
  };
  jobs.set(jobKey(input.auth, jobId), record);
  void runIntentAnalysisJob(jobKey(input.auth, jobId), () => analyzeLoopBuilderIntent(input));
  return toView(record);
}

export function resolveIntentContextFromJob(input: {
  auth: AuthContext;
  jobId: string;
  answers?: LoopIntentAnswer[];
  skippedQuestionIds?: string[];
}): LoopIntentContext {
  const job = jobs.get(jobKey(input.auth, input.jobId));
  if (!job || job.kind !== "analyze-intent" || job.status !== "completed" || !job.intentAnalysis) {
    throw new Error("Completed intent analysis job not found");
  }
  return resolveLoopIntentContext({
    analysis: job.intentAnalysis,
    answers: input.answers,
    skippedQuestionIds: input.skippedQuestionIds,
  });
}

async function runJob(jobId: string, runner: () => Promise<LoopBuilderProposal>): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = "running";
  appendEvent(job, { stage: "agent_generation", message: "Searching tools and compiling the executable agent graph", status: "running" });

  try {
    job.proposal = await progressRunner(job, runner);
    job.status = "completed";
    appendEvent(job, { stage: "agent_generation", message: "Agent graph generation completed", status: "completed" });
    job.error = undefined;
  } catch (error) {
    job.status = "failed";
    appendEvent(job, { stage: "agent_generation", message: "Agent graph generation failed", status: "failed" });
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    job.error = errorStack ? `${errorMessage}\n\nStack trace:\n${errorStack}` : errorMessage;
    console.error(`[loop-builder] Job ${jobId} failed:`, error);
  } finally {
    job.updatedAt = new Date().toISOString();
  }
}

export function enqueueLoopBuilderProposeJob(input: {
  auth: AuthContext;
  prompt: string;
  templateId?: LoopBuilderTemplateHint;
  feedback?: string;
  specId?: string;
}): LoopBuilderJobView {
  pruneExpiredJobs();
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const record: LoopBuilderJobRecord = {
    jobId,
    kind: "propose",
    status: "pending",
    tenantId: input.auth.tenantId,
    userId: input.auth.userId,
    createdAt: now,
    updatedAt: now,
    events: [],
    usage: emptyLoopBuilderUsage(),
  };
  jobs.set(jobKey(input.auth, jobId), record);

  void runJob(jobKey(input.auth, jobId), () => resolveLoopBuilderIntent({
    auth: input.auth,
    prompt: input.prompt,
    templateId: input.templateId,
    feedback: input.feedback,
    specId: input.specId,
  }));

  return toView(record);
}

export function enqueueLoopBuilderRefineJob(input: {
  auth: AuthContext;
  prompt: string;
  templateId?: LoopBuilderTemplateHint;
  feedback?: string;
  specId?: string;
  priorProposal: LoopBuilderProposal;
}): LoopBuilderJobView {
  pruneExpiredJobs();
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const record: LoopBuilderJobRecord = {
    jobId,
    kind: "refine",
    status: "pending",
    tenantId: input.auth.tenantId,
    userId: input.auth.userId,
    createdAt: now,
    updatedAt: now,
    events: [],
    usage: emptyLoopBuilderUsage(),
  };
  jobs.set(jobKey(input.auth, jobId), record);

  void runJob(jobKey(input.auth, jobId), () => refineLoopBuilderProposal({
    auth: input.auth,
    prompt: input.prompt,
    templateId: input.templateId,
    feedback: input.feedback,
    specId: input.specId,
    priorProposal: input.priorProposal,
  }));

  return toView(record);
}

export function getLoopBuilderJob(auth: AuthContext, jobId: string): LoopBuilderJobView | null {
  pruneExpiredJobs();
  const job = jobs.get(jobKey(auth, jobId));
  if (!job) return null;
  return toView(job);
}

export function enqueueSpecDraftJob(input: {
  auth: AuthContext;
  prompt: string;
  intentContext?: LoopIntentContext;
}): LoopBuilderJobView {
  pruneExpiredJobs();
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const record: LoopBuilderJobRecord = {
    jobId,
    kind: "draft-spec",
    status: "pending",
    tenantId: input.auth.tenantId,
    userId: input.auth.userId,
    createdAt: now,
    updatedAt: now,
    events: [],
    usage: emptyLoopBuilderUsage(),
  };
  jobs.set(jobKey(input.auth, jobId), record);

  void runSpecJob(jobKey(input.auth, jobId), () => draftLoopSpec({
    auth: input.auth,
    prompt: input.prompt,
    intentContext: input.intentContext,
  }));

  return toView(record);
}

export function enqueueSpecRefineJob(input: {
  auth: AuthContext;
  specId: string;
  feedback: string;
}): LoopBuilderJobView {
  pruneExpiredJobs();
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const record: LoopBuilderJobRecord = {
    jobId,
    kind: "refine-spec",
    status: "pending",
    tenantId: input.auth.tenantId,
    userId: input.auth.userId,
    createdAt: now,
    updatedAt: now,
    events: [],
    usage: emptyLoopBuilderUsage(),
  };
  jobs.set(jobKey(input.auth, jobId), record);

  void runSpecJob(jobKey(input.auth, jobId), () => refineLoopSpec({
    auth: input.auth,
    specId: input.specId,
    feedback: input.feedback,
  }));

  return toView(record);
}

async function runSpecJob(jobId: string, runner: () => Promise<LoopSpecView>): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = "running";
  appendEvent(job, { stage: "spec_generation", message: "Generating and validating the behavioral spec", status: "running" });

  try {
    job.spec = await progressRunner(job, runner);
    job.status = "completed";
    appendEvent(job, { stage: "spec_generation", message: "Behavioral spec completed", status: "completed" });
    job.error = undefined;
  } catch (error) {
    job.status = "failed";
    appendEvent(job, { stage: "spec_generation", message: "Behavioral spec generation failed", status: "failed" });
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    job.error = errorStack ? `${errorMessage}\n\nStack trace:\n${errorStack}` : errorMessage;
    console.error(`[loop-builder] Spec job ${jobId} failed:`, error);
  } finally {
    job.updatedAt = new Date().toISOString();
  }
}
