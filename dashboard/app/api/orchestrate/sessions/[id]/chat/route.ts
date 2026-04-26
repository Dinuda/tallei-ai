import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { NextRequest } from "next/server";

import { auth } from "../../../../../../auth";

type OrchestrationStatus = "DRAFT" | "INTERVIEWING" | "PLAN_READY" | "RUNNING" | "DONE" | "ABORTED";

type ArticleItem = {
  query: string;
  url: string;
  snippet: string;
};

type UploadSavedItem = {
  ref: string;
  title: string | null;
  filename: string | null;
};

type UploadFailedItem = {
  filename: string | null;
  error: string;
  status: number;
};

type ChatDataParts = {
  question: {
    sessionId: string;
    question: string;
    status: OrchestrationStatus;
  };
  articles: {
    items: ArticleItem[];
  };
  "upload-summary": {
    saved: UploadSavedItem[];
    failed: UploadFailedItem[];
  };
  "plan-ready": {
    title: string;
    summary: string;
    successCriteriaCount: number;
  };
};

type ChatMessage = UIMessage<unknown, ChatDataParts>;

type PlannerTurn = {
  role: "planner" | "user" | "system";
  content: string;
  ts: string;
  web_searches?: ArticleItem[];
};

type SessionPlan = {
  title: string;
  summary: string;
  success_criteria?: Array<{ id: string; text: string; weight: number }>;
};

type SessionResponse = {
  session?: {
    id: string;
    status: OrchestrationStatus;
    transcript: PlannerTurn[];
    plan: SessionPlan | null;
  };
  status?: OrchestrationStatus;
  question?: string | null;
  plan?: SessionPlan | null;
  error?: string;
};

type IncomingMessage = {
  role?: string;
  parts?: Array<
    | { type: "text"; text?: string }
    | { type: "file"; url?: string; mediaType?: string; filename?: string }
    | { type: string; [key: string]: unknown }
  >;
};

const SECRET = process.env.INTERNAL_API_SECRET;
const BACKEND_TIMEOUT_MS = 60_000;
const MAX_CONTEXT_DOCS = 3;
const MAX_CONTEXT_CHARS = 1200;
const STREAM_CHUNK_DELAY_MS = 22;
const STREAM_MIN_CHUNK_CHARS = 8;
const STREAM_MAX_CHUNK_CHARS = 26;

function resolveBackendUrl(req?: NextRequest): string {
  const configured =
    process.env.BACKEND_URL ||
    process.env.API_PROXY_TARGET ||
    "http://127.0.0.1:3000";

  if (!req) return configured.replace(/\/$/, "");

  try {
    const backendOrigin = new URL(configured).origin;
    if (backendOrigin === req.nextUrl.origin) {
      const fallback = process.env.API_PROXY_TARGET || "http://127.0.0.1:3000";
      return fallback.replace(/\/$/, "");
    }
  } catch {
    // Use configured value as-is if URL parsing fails.
  }

  return configured.replace(/\/$/, "");
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Unexpected error while handling chat request.";
}

function latestUserMessage(messages: IncomingMessage[]): IncomingMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return messages[i];
  }
  return null;
}

function extractText(parts: IncomingMessage["parts"]): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part): part is { type: "text"; text?: string } => part?.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function extractFiles(parts: IncomingMessage["parts"]): Array<{ url: string; mediaType: string; filename: string | null }> {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((part): part is { type: "file"; url?: string; mediaType?: string; filename?: string } => part?.type === "file")
    .map((part) => ({
      url: typeof part.url === "string" ? part.url : "",
      mediaType: typeof part.mediaType === "string" && part.mediaType.trim() ? part.mediaType : "application/octet-stream",
      filename: typeof part.filename === "string" && part.filename.trim() ? part.filename : null,
    }))
    .filter((part) => part.url.length > 0);
}

function dataUrlToBlob(url: string, fallbackMediaType: string): Blob | null {
  if (!url.startsWith("data:")) return null;
  const commaIndex = url.indexOf(",");
  if (commaIndex < 0) return null;

  const meta = url.slice(5, commaIndex);
  const raw = url.slice(commaIndex + 1);
  const isBase64 = meta.includes(";base64");
  const mediaType = meta.split(";")[0] || fallbackMediaType || "application/octet-stream";

  try {
    const bytes = isBase64
      ? Buffer.from(raw, "base64")
      : Buffer.from(decodeURIComponent(raw), "utf8");
    return new Blob([bytes], { type: mediaType });
  } catch {
    return null;
  }
}

async function uploadAttachment(input: {
  backend: string;
  userId: string;
  file: { url: string; mediaType: string; filename: string | null };
}): Promise<{ saved?: UploadSavedItem; failed?: UploadFailedItem }> {
  const blob = dataUrlToBlob(input.file.url, input.file.mediaType);
  if (!blob) {
    return {
      failed: {
        filename: input.file.filename,
        error: "Unsupported attachment payload. Please re-attach the file and retry.",
        status: 422,
      },
    };
  }

  const fileName = input.file.filename ?? "attachment";
  const form = new FormData();
  form.append("file", blob, fileName);
  form.append("mode", "note");
  form.append("title", fileName);

  const uploadRes = await fetchWithTimeout(`${input.backend}/api/documents/upload`, {
    method: "POST",
    headers: {
      "X-Internal-Secret": SECRET!,
      "X-User-Id": input.userId,
    },
    body: form,
  });

  const uploadBody = await safeJson<{ ref?: string; title?: string | null; error?: string }>(uploadRes);

  if (!uploadRes.ok || !uploadBody?.ref) {
    return {
      failed: {
        filename: input.file.filename,
        status: uploadRes.status,
        error: typeof uploadBody?.error === "string" ? uploadBody.error : "Failed to upload attachment.",
      },
    };
  }

  return {
    saved: {
      ref: uploadBody.ref,
      title: typeof uploadBody.title === "string" ? uploadBody.title : fileName,
      filename: input.file.filename,
    },
  };
}

async function loadDocumentContext(input: {
  backend: string;
  userId: string;
  ref: string;
}): Promise<{ title: string; snippet: string } | null> {
  const res = await fetchWithTimeout(`${input.backend}/api/documents/${encodeURIComponent(input.ref)}`, {
    headers: {
      "X-Internal-Secret": SECRET!,
      "X-User-Id": input.userId,
    },
  });

  if (!res.ok) return null;

  const body = await safeJson<{
    kind?: "document" | "lot";
    title?: string | null;
    filename?: string | null;
    ref?: string;
    content?: string;
  }>(res);

  if (body?.kind !== "document" || typeof body.content !== "string") return null;

  const snippet = body.content.trim().slice(0, MAX_CONTEXT_CHARS);
  if (!snippet) return null;

  return {
    title: body.title ?? body.filename ?? body.ref ?? input.ref,
    snippet,
  };
}

function latestPlannerTurn(transcript: PlannerTurn[] | undefined): PlannerTurn | null {
  if (!Array.isArray(transcript)) return null;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i]?.role === "planner") return transcript[i];
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkTextForStream(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [""];

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < trimmed.length) {
    const remaining = trimmed.length - cursor;
    const targetSize = Math.min(
      remaining,
      Math.max(
        STREAM_MIN_CHUNK_CHARS,
        Math.floor(Math.random() * (STREAM_MAX_CHUNK_CHARS - STREAM_MIN_CHUNK_CHARS + 1)) + STREAM_MIN_CHUNK_CHARS
      )
    );

    let end = cursor + targetSize;
    if (end < trimmed.length) {
      const nextSpace = trimmed.indexOf(" ", end);
      if (nextSpace > 0 && nextSpace - cursor <= STREAM_MAX_CHUNK_CHARS + 10) {
        end = nextSpace + 1;
      }
    }

    chunks.push(trimmed.slice(cursor, end));
    cursor = end;
  }

  return chunks;
}

function streamSingleAssistantMessage(input: {
  text: string;
  question?: { sessionId: string; question: string; status: OrchestrationStatus };
  articles?: { items: ArticleItem[] };
  uploadSummary?: { saved: UploadSavedItem[]; failed: UploadFailedItem[] };
  planReady?: { title: string; summary: string; successCriteriaCount: number };
  status?: number;
}) {
  const stream = createUIMessageStream<ChatMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });

      const textId = "assistant-text";
      writer.write({ type: "text-start", id: textId });

      const chunks = chunkTextForStream(input.text);
      for (let i = 0; i < chunks.length; i += 1) {
        writer.write({ type: "text-delta", id: textId, delta: chunks[i] });
        if (i < chunks.length - 1) {
          await sleep(STREAM_CHUNK_DELAY_MS);
        }
      }
      writer.write({ type: "text-end", id: textId });

      if (input.uploadSummary) {
        writer.write({
          type: "data-upload-summary",
          data: input.uploadSummary,
        });
      }

      if (input.question) {
        writer.write({
          type: "data-question",
          data: input.question,
        });
      }

      if (input.articles && input.articles.items.length > 0) {
        writer.write({
          type: "data-articles",
          data: input.articles,
        });
      }

      if (input.planReady) {
        writer.write({
          type: "data-plan-ready",
          data: input.planReady,
        });
      }

      writer.write({ type: "finish" });
    },
  });

  return createUIMessageStreamResponse({
    status: input.status,
    stream,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!SECRET) {
    return Response.json(
      { error: "Dashboard misconfigured: INTERNAL_API_SECRET is not set." },
      { status: 500 }
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;

  let body: { messages?: IncomingMessage[] };
  try {
    body = (await req.json()) as { messages?: IncomingMessage[] };
  } catch {
    return streamSingleAssistantMessage({
      status: 400,
      text: "Invalid request body.",
    });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const latestUser = latestUserMessage(messages);
  const text = extractText(latestUser?.parts);
  const files = extractFiles(latestUser?.parts);

  const backend = resolveBackendUrl(req);
  const savedUploads: UploadSavedItem[] = [];
  const failedUploads: UploadFailedItem[] = [];

  try {
    for (const file of files) {
      const result = await uploadAttachment({
        backend,
        userId: session.user.id,
        file,
      });
      if (result.saved) savedUploads.push(result.saved);
      if (result.failed) failedUploads.push(result.failed);
    }

    if (!text && savedUploads.length === 0 && failedUploads.length > 0) {
      return streamSingleAssistantMessage({
        status: 422,
        text: "All attachments failed to upload. Re-attach a PDF or DOCX file and try again.",
        uploadSummary: {
          saved: savedUploads,
          failed: failedUploads,
        },
      });
    }

    const contextDocs: Array<{ title: string; snippet: string }> = [];
    for (const item of savedUploads.slice(0, MAX_CONTEXT_DOCS)) {
      const doc = await loadDocumentContext({
        backend,
        userId: session.user.id,
        ref: item.ref,
      });
      if (doc) contextDocs.push(doc);
    }

    const contextBlock = contextDocs
      .map((doc, idx) => `Document ${idx + 1}: ${doc.title}\n${doc.snippet}`)
      .join("\n\n");

    const answer = [
      text,
      contextBlock
        ? `Uploaded document context (note mode):\n${contextBlock}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (!answer) {
      return streamSingleAssistantMessage({
        status: 400,
        text: "Please provide an answer or attach at least one document.",
      });
    }

    const answerRes = await fetchWithTimeout(`${backend}/api/orchestrate/sessions/${sessionId}/answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": SECRET,
        "X-User-Id": session.user.id,
      },
      body: JSON.stringify({ answer }),
    });

    const answerBody = await safeJson<SessionResponse>(answerRes);

    if (!answerRes.ok || !answerBody?.session) {
      return streamSingleAssistantMessage({
        status: answerRes.status,
        text:
          typeof answerBody?.error === "string"
            ? answerBody.error
            : "Failed to continue the orchestration session.",
        uploadSummary: {
          saved: savedUploads,
          failed: failedUploads,
        },
      });
    }

    const nextStatus = answerBody.session.status;
    const latestPlanner = latestPlannerTurn(answerBody.session.transcript);
    const articles = latestPlanner?.web_searches ?? [];
    const question = typeof answerBody.question === "string" ? answerBody.question.trim() : "";

    const responseText = question
      || latestPlanner?.content
      || (nextStatus === "PLAN_READY" ? "Plan is ready for review." : "Saved.");

    return streamSingleAssistantMessage({
      text: responseText,
      uploadSummary: {
        saved: savedUploads,
        failed: failedUploads,
      },
      question: question
        ? {
            sessionId,
            question,
            status: nextStatus,
          }
        : undefined,
      articles: articles.length > 0 ? { items: articles } : undefined,
      planReady:
        nextStatus === "PLAN_READY" && answerBody.session.plan
          ? {
              title: answerBody.session.plan.title,
              summary: answerBody.session.plan.summary,
              successCriteriaCount: Array.isArray(answerBody.session.plan.success_criteria)
                ? answerBody.session.plan.success_criteria.length
                : 0,
            }
          : undefined,
    });
  } catch (error) {
    return streamSingleAssistantMessage({
      status: 500,
      text: toErrorMessage(error),
      uploadSummary: savedUploads.length || failedUploads.length
        ? {
            saved: savedUploads,
            failed: failedUploads,
          }
        : undefined,
    });
  }
}
