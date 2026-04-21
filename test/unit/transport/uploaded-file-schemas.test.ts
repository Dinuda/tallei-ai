import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { conversationIdSchema, openAiFileRefSchema, uploadBlobBodySchema } from "../../../src/transport/http/schemas/uploaded-files.js";

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
