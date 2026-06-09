import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import {
  refineLoopBuilderProposal,
  resolveLoopBuilderIntent,
  type LoopBuilderProposal,
  type LoopBuilderTemplateHint,
} from "./intent-resolver.js";
import { draftLoopSpec, refineLoopSpec, type LoopSpecView } from "./specs.js";

export type LoopBuilderJobStatus = "pending" | "running" | "completed" | "failed";

export type LoopBuilderJobKind = "propose" | "refine" | "draft-spec" | "refine-spec";

export interface LoopBuilderJobView {
  jobId: string;
  kind: LoopBuilderJobKind;
  status: LoopBuilderJobStatus;
  createdAt: string;
  updatedAt: string;
  proposal?: LoopBuilderProposal;
  spec?: LoopSpecView;
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
    ...(job.proposal ? { proposal: job.proposal } : {}),
    ...(job.spec ? { spec: job.spec } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

async function runJob(jobId: string, runner: () => Promise<LoopBuilderProposal>): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = "running";
  job.updatedAt = new Date().toISOString();

  try {
    job.proposal = await runner();
    job.status = "completed";
    job.error = undefined;
  } catch (error) {
    job.status = "failed";
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
  };
  jobs.set(jobKey(input.auth, jobId), record);

  void runSpecJob(jobKey(input.auth, jobId), () => draftLoopSpec({
    auth: input.auth,
    prompt: input.prompt,
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
  job.updatedAt = new Date().toISOString();

  try {
    job.spec = await runner();
    job.status = "completed";
    job.error = undefined;
  } catch (error) {
    job.status = "failed";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    job.error = errorStack ? `${errorMessage}\n\nStack trace:\n${errorStack}` : errorMessage;
    console.error(`[loop-builder] Spec job ${jobId} failed:`, error);
  } finally {
    job.updatedAt = new Date().toISOString();
  }
}
