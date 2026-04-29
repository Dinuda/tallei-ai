import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import {
  conversationIdSchema,
  normalizeUploadedFileRequestBody,
  openAiFileRefSchema,
  uploadBlobBodySchema,
} from "../../../src/transport/http/schemas/uploaded-files.js";

const recallLikeSchema = z.object({
  query: z.string().optional(),
  openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
  conversation_id: conversationIdSchema,
});

const rememberLikeSchema = z.object({
  kind: z.string(),
  openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
  conversation_id: conversationIdSchema,
});

test("conversation_id is accepted for recall-like payloads", () => {
  const parsed = recallLikeSchema.parse({
    query: "remember this",
    conversation_id: "conv_abc",
    openaiFileIdRefs: [
      {
        id: "file_1",
        name: "a.pdf",
        mime_type: "application/pdf",
        download_link: "https://example.com/a.pdf",
      },
    ],
  });

  assert.equal(parsed.conversation_id, "conv_abc");
});

test("conversation_id is accepted for remember-like payloads", () => {
  const parsed = rememberLikeSchema.parse({
    kind: "document-note",
    conversation_id: "conv_xyz",
    openaiFileIdRefs: [
      {
        id: "file_2",
        name: "b.txt",
        mime_type: "text/plain",
        download_link: "https://example.com/b.txt",
      },
    ],
  });

  assert.equal(parsed.conversation_id, "conv_xyz");
});

test("uploadBlobBodySchema rejects malformed openaiFileIdRefs", () => {
  assert.throws(
    () =>
      uploadBlobBodySchema.parse({
        openaiFileIdRefs: [
          {
            id: "file_3",
            name: "bad.txt",
            mime_type: "text/plain",
          },
        ],
      }),
    /download_link/
  );
});

test("normalizeUploadedFileRequestBody accepts top-level and item aliases", () => {
  const normalized = normalizeUploadedFileRequestBody({
    files: [
      {
        fileId: "file_alias",
        filename: "alias.pdf",
        mimeType: "application/pdf",
        downloadLink: "https://example.com/alias.pdf",
      },
    ],
    conversation_id: "conv_alias",
  });

  const parsed = uploadBlobBodySchema.parse(normalized);
  assert.equal(parsed.openaiFileIdRefs.length, 1);
  assert.equal(parsed.openaiFileIdRefs[0]?.id, "file_alias");
  assert.equal(parsed.openaiFileIdRefs[0]?.download_link, "https://example.com/alias.pdf");
  assert.equal(parsed.openaiFileIdRefs[0]?.mime_type, "application/pdf");
});

test("normalizeUploadedFileRequestBody accepts stringified refs", () => {
  const normalized = normalizeUploadedFileRequestBody({
    openai_file_id_refs: JSON.stringify([
      {
        file_id: "file_json",
        name: "json.txt",
        mime_type: "text/plain",
        download_url: "https://example.com/json.txt",
      },
    ]),
  });

  const parsed = uploadBlobBodySchema.parse(normalized);
  assert.equal(parsed.openaiFileIdRefs.length, 1);
  assert.equal(parsed.openaiFileIdRefs[0]?.id, "file_json");
  assert.equal(parsed.openaiFileIdRefs[0]?.download_link, "https://example.com/json.txt");
});

test("normalizeUploadedFileRequestBody accepts nested payload wrappers", () => {
  const normalized = normalizeUploadedFileRequestBody({
    payload: {
      openaiFileRefs: [
        {
          fileId: "file_nested",
          filename: "nested.pdf",
          mimeType: "application/pdf",
          downloadLink: "https://example.com/nested.pdf",
        },
      ],
    },
    conversation_id: "conv_nested",
  });

  const parsed = uploadBlobBodySchema.parse(normalized);
  assert.equal(parsed.openaiFileIdRefs[0]?.id, "file_nested");
  assert.equal(parsed.openaiFileIdRefs[0]?.download_link, "https://example.com/nested.pdf");
  assert.equal(parsed.conversation_id, "conv_nested");
});

test("normalizeUploadedFileRequestBody accepts singular nested file aliases", () => {
  const normalized = normalizeUploadedFileRequestBody({
    attachment: {
      file: {
        file_id: "file_single",
        filename: "single.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        downloadURL: "https://example.com/single.docx",
      },
    },
  });

  const parsed = uploadBlobBodySchema.parse(normalized);
  assert.equal(parsed.openaiFileIdRefs.length, 1);
  assert.equal(parsed.openaiFileIdRefs[0]?.id, "file_single");
  assert.equal(parsed.openaiFileIdRefs[0]?.download_link, "https://example.com/single.docx");
});

test("normalizeUploadedFileRequestBody accepts deeply nested arrays", () => {
  const normalized = normalizeUploadedFileRequestBody({
    request: {
      turns: [
        {
          payload: {
            resources: [
              {
                id: "file_deep",
                name: "deep.pdf",
                mime_type: "application/pdf",
                download_link: "https://example.com/deep.pdf",
              },
            ],
          },
        },
      ],
    },
  });

  const parsed = uploadBlobBodySchema.parse(normalized);
  assert.equal(parsed.openaiFileIdRefs.length, 1);
  assert.equal(parsed.openaiFileIdRefs[0]?.id, "file_deep");
});

test("normalizeUploadedFileRequestBody accepts stringified object body", () => {
  const normalized = normalizeUploadedFileRequestBody(JSON.stringify({
    attachments: [
      {
        fileId: "file_string_body",
        filename: "string.pdf",
        mimeType: "application/pdf",
        downloadLink: "https://example.com/string.pdf",
      },
    ],
  }));

  const parsed = uploadBlobBodySchema.parse(normalized);
  assert.equal(parsed.openaiFileIdRefs.length, 1);
  assert.equal(parsed.openaiFileIdRefs[0]?.id, "file_string_body");
});

test("normalizeUploadedFileRequestBody keeps local download_link paths (schema validation rejects non-URL)", () => {
  const normalized = normalizeUploadedFileRequestBody({
    openaiFileIdRefs: [
      {
        id: "file_local_path",
        name: "lesson-plan.pdf",
        mime_type: "application/pdf",
        download_link: "/mnt/data/lesson-plan.pdf",
      },
    ],
  });

  assert.throws(
    () => uploadBlobBodySchema.parse(normalized),
    /download_link/
  );
});
