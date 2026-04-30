import { z } from "zod";

export const conversationIdSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(200).optional()
);

export const openAiFileRefSchema = z.object({
  id: z.string().min(1, "file id is required"),
  name: z.string().optional(),
  mime_type: z.string().nullable().optional(),
  download_link: z.string()
    .url("download_link must be a valid URL")
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "https:" || protocol === "http:";
      } catch {
        return false;
      }
    }, "download_link must be an http(s) URL from GPT Actions (not file:// or local paths)"),
});

export const uploadBlobBodySchema = z.object({
  openaiFileIdRefs: z.array(openAiFileRefSchema).min(1).max(10),
  conversation_id: conversationIdSchema,
  title: z.string().optional(),
});

export type OpenAiFileRef = z.infer<typeof openAiFileRefSchema>;

const FILE_REF_TOP_LEVEL_KEYS = [
  "openaiFileIdRefs",
  "openaiFileIdRef",
  "openaiFileRefs",
  "openaiFileRef",
  "openai_file_id_refs",
  "openai_file_id_ref",
  "openai_file_refs",
  "openai_file_ref",
  "openai_files",
  "file_refs",
  "file_ref",
  "fileRefs",
  "fileRef",
  "uploadedFiles",
  "uploaded_files",
  "files",
  "file",
  "attachments",
  "attachment",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function normalizeOpenAiFileRefLike(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const nested = asRecord(firstDefined(record, ["file", "attachment", "ref", "fileRef", "openai_file", "openaiFile"]));
  const source = nested ?? record;

  return {
    id: firstDefined(source, ["id", "file_id", "fileId"]),
    name: firstDefined(source, ["name", "filename"]),
    mime_type: firstDefined(source, ["mime_type", "mimeType", "type", "content_type", "contentType"]),
    download_link: firstDefined(source, ["download_link", "downloadLink", "download_url", "downloadURL", "download_uri", "downloadUri", "url", "link"]),
  };
}

function looksLikeFileRef(value: unknown): boolean {
  const normalized = normalizeOpenAiFileRefLike(value);
  const record = asRecord(normalized);
  if (!record) return false;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const link = typeof record.download_link === "string" ? record.download_link.trim() : "";
  return id.length > 0 && link.length > 0;
}

function findDeepFileRefsCandidate(root: unknown): unknown {
  const queue: unknown[] = [root];
  const visited = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    if (Array.isArray(current)) {
      if (current.length > 0 && current.some((item) => looksLikeFileRef(item))) {
        return current;
      }
      for (const item of current) {
        if (item && typeof item === "object") queue.push(item);
      }
      continue;
    }

    const record = asRecord(current);
    if (!record) continue;
    if (visited.has(record)) continue;
    visited.add(record);

    const direct = firstDefined(record, FILE_REF_TOP_LEVEL_KEYS);
    if (direct !== undefined) return direct;
    if (looksLikeFileRef(record)) return [record];

    for (const value of Object.values(record)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }

  return undefined;
}

function coerceFileRefsArray(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (looksLikeFileRef(value)) return [value];
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (looksLikeFileRef(parsed)) return [parsed];
    return parsed;
  } catch {
    return value;
  }
}

export function normalizeUploadedFileRequestBody(body: unknown): unknown {
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return body;
    try {
      return normalizeUploadedFileRequestBody(JSON.parse(trimmed));
    } catch {
      return body;
    }
  }

  if (Array.isArray(body) && body.some((item) => looksLikeFileRef(item))) {
    return {
      openaiFileIdRefs: body.map((item) => normalizeOpenAiFileRefLike(item)),
    };
  }

  const record = asRecord(body);
  if (!record) return body;

  const normalized: Record<string, unknown> = { ...record };
  const wrappers = [
    record,
    asRecord(record["data"]),
    asRecord(record["payload"]),
    asRecord(record["args"]),
    asRecord(record["input"]),
  ].filter((value): value is Record<string, unknown> => Boolean(value));

  let refCandidate: unknown = undefined;
  for (const source of wrappers) {
    refCandidate = firstDefined(source, FILE_REF_TOP_LEVEL_KEYS);
    if (refCandidate !== undefined) break;
  }
  if (refCandidate === undefined) {
    refCandidate = findDeepFileRefsCandidate(record);
  }

  const coercedRefs = coerceFileRefsArray(refCandidate);
  const arrayRefs = Array.isArray(coercedRefs)
    ? coercedRefs
    : looksLikeFileRef(coercedRefs)
      ? [coercedRefs]
      : [];

  if (arrayRefs.length > 0) {
    normalized.openaiFileIdRefs = arrayRefs.map((item) => normalizeOpenAiFileRefLike(item));
  }

  return normalized;
}
