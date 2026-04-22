import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

import type { AuthContext } from "../domain/auth/index.js";
import { uploadBufferToUploadThing } from "../infrastructure/storage/uploadthing-client.js";
import { stashDocument, type DocumentBlobMetadata } from "./documents.js";

export interface UploadedFileRef {
  id: string;
  name?: string;
  mime_type?: string | null;
  download_link: string;
}

export interface SavedUploadedFileDocument {
  ref: string;
  status: "pending";
  title: string;
  filename: string | null;
  conversation_id: string | null;
  blob: {
    provider: "uploadthing";
    key: string;
    url: string;
    source_file_id: string;
  };
}

export interface UploadedFileSaveError {
  file_id: string;
  filename: string;
  error: string;
}

interface IngestUploadedFileDeps {
  fetchBuffer: (ref: UploadedFileRef) => Promise<Buffer>;
  toText: (ref: UploadedFileRef, buffer: Buffer) => Promise<string>;
  uploadBlob: (input: { buffer: Buffer; filename: string; mimeType?: string | null }) => Promise<{
    provider: "uploadthing";
    key: string;
    url: string;
  }>;
  stashBlobDocument: (
    content: string,
    auth: AuthContext,
    opts: {
      filename?: string;
      title?: string;
      mimeType?: string;
      conversationId?: string | null;
      blob?: DocumentBlobMetadata;
    }
  ) => Promise<{ refHandle: string; status: "pending"; lotRef?: string; conversationId: string | null; blob: DocumentBlobMetadata | null }>;
}

const defaultDeps: IngestUploadedFileDeps = {
  fetchBuffer: fetchUploadedFileBuffer,
  toText: uploadedFileToText,
  uploadBlob: uploadBufferToUploadThing,
  stashBlobDocument: stashDocument,
};

export function isPdfLikeFile(ref: UploadedFileRef): boolean {
  const mime = (ref.mime_type ?? "").toLowerCase();
  const name = (ref.name ?? "").toLowerCase();
  return mime === "application/pdf" || name.endsWith(".pdf");
}

export function isDocxLikeFile(ref: UploadedFileRef): boolean {
  const mime = (ref.mime_type ?? "").toLowerCase();
  const name = (ref.name ?? "").toLowerCase();
  return (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || mime === "application/vnd.ms-word.document.macroenabled.12"
    || name.endsWith(".docx")
    || name.endsWith(".docm")
  );
}

export function isLegacyDocFile(ref: UploadedFileRef): boolean {
  const mime = (ref.mime_type ?? "").toLowerCase();
  const name = (ref.name ?? "").toLowerCase();
  return mime === "application/msword" || name.endsWith(".doc");
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text;
}

export async function extractWordText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export async function fetchUploadedFileBuffer(ref: UploadedFileRef): Promise<Buffer> {
  const response = await fetch(ref.download_link, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download uploaded file ${ref.id}: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function uploadedFileToText(ref: UploadedFileRef, buffer: Buffer): Promise<string> {
  if (isPdfLikeFile(ref)) {
    return extractPdfText(buffer);
  }
  if (isDocxLikeFile(ref)) {
    return extractWordText(buffer);
  }
  if (isLegacyDocFile(ref)) {
    throw new Error("Legacy .doc files are not supported yet. Please upload as .docx.");
  }
  return buffer.toString("utf8");
}

export function buildDocumentNoteDraft(input: {
  name: string;
  titleOverride?: string;
  sourceHint?: string;
  text: string;
}): { title: string; key_points: string[]; summary: string; source_hint: string } {
  const preview = input.text.slice(0, 3000);
  const lines = preview
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 20)
    .slice(0, 8);
  return {
    title: input.titleOverride?.trim() || input.name || "Uploaded Document",
    key_points: lines,
    summary: `Uploaded file: ${input.name || "document"}`,
    source_hint: input.sourceHint?.trim() || `Uploaded via ChatGPT action — ${input.name || "document"}`,
  };
}

export async function ingestUploadedFileToDocument(
  fileRef: UploadedFileRef,
  auth: AuthContext,
  input?: {
    title?: string;
    conversation_id?: string | null;
  },
  deps: IngestUploadedFileDeps = defaultDeps
): Promise<SavedUploadedFileDocument> {
  const filename = fileRef.name?.trim() || `upload-${fileRef.id}`;
  const buffer = await deps.fetchBuffer(fileRef);
  const uploadedBlob = await deps.uploadBlob({
    buffer,
    filename,
    mimeType: fileRef.mime_type ?? null,
  });
  const text = (await deps.toText(fileRef, buffer)).trim();

  if (!text) {
    throw new Error("Empty content after parsing");
  }

  const blobMeta: DocumentBlobMetadata = {
    provider: uploadedBlob.provider,
    key: uploadedBlob.key,
    url: uploadedBlob.url,
    sourceFileId: fileRef.id,
  };

  const saved = await deps.stashBlobDocument(text, auth, {
    title: input?.title ?? fileRef.name ?? "Uploaded Document",
    filename: fileRef.name ?? undefined,
    mimeType: fileRef.mime_type ?? undefined,
    conversationId: input?.conversation_id ?? null,
    blob: blobMeta,
  });

  return {
    ref: saved.refHandle,
    status: saved.status,
    title: input?.title ?? fileRef.name ?? "Uploaded Document",
    filename: fileRef.name ?? null,
    conversation_id: saved.conversationId,
    blob: {
      provider: blobMeta.provider,
      key: blobMeta.key,
      url: blobMeta.url,
      source_file_id: blobMeta.sourceFileId,
    },
  };
}

export async function ingestUploadedFilesToDocuments(
  fileRefs: UploadedFileRef[],
  auth: AuthContext,
  input?: {
    title?: string;
    conversation_id?: string | null;
  },
  deps: IngestUploadedFileDeps = defaultDeps
): Promise<{
  saved: SavedUploadedFileDocument[];
  errors: UploadedFileSaveError[];
}> {
  const saved: SavedUploadedFileDocument[] = [];
  const errors: UploadedFileSaveError[] = [];

  for (const fileRef of fileRefs) {
    try {
      const result = await ingestUploadedFileToDocument(fileRef, auth, input, deps);
      saved.push(result);
    } catch (error) {
      errors.push({
        file_id: fileRef.id,
        filename: fileRef.name ?? fileRef.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { saved, errors };
}
