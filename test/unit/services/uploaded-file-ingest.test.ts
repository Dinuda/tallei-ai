import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import {
  ingestUploadedFileToDocument,
  ingestUploadedFilesToDocuments,
  isDocxLikeFile,
  isImageLikeFile,
  isLegacyDocFile,
  isPdfLikeFile,
  uploadedFileToText,
  type UploadedFileRef,
} from "../../../src/services/uploaded-file-ingest.js";

const auth: AuthContext = {
  userId: "u_1",
  tenantId: "t_1",
  authMode: "internal",
  plan: "pro",
};

test("ingestUploadedFileToDocument saves parsed text and blob metadata", async () => {
  const fileRef: UploadedFileRef = {
    id: "file_123",
    name: "catalog.pdf",
    mime_type: "application/pdf",
    download_link: "https://example.com/file.pdf",
  };

  const calls: string[] = [];
  const result = await ingestUploadedFileToDocument(
    fileRef,
    auth,
    { title: "Catalog", conversation_id: "conv_42" },
    {
      fetchBuffer: async () => {
        calls.push("fetchBuffer");
        return Buffer.from("raw-binary");
      },
      uploadBlob: async () => {
        calls.push("uploadBlob");
        return { provider: "uploadthing", key: "blob-key", url: "https://utfs.io/f/blob-key" };
      },
      toText: async () => {
        calls.push("toText");
        return "Extracted PDF text";
      },
      stashBlobDocument: async (content, _auth, opts) => {
        calls.push("stashBlobDocument");
        assert.equal(content, "Extracted PDF text");
        assert.equal(opts.title, "Catalog");
        assert.equal(opts.conversationId, "conv_42");
        assert.equal(opts.blob?.sourceFileId, "file_123");
        return {
          refHandle: "@doc:catalog-abcd",
          status: "pending",
          conversationId: "conv_42",
          blob: opts.blob ?? null,
        };
      },
    }
  );

  assert.deepEqual(calls, ["fetchBuffer", "uploadBlob", "toText", "stashBlobDocument"]);
  assert.equal(result.ref, "@doc:catalog-abcd");
  assert.equal(result.conversation_id, "conv_42");
  assert.equal(result.blob.provider, "uploadthing");
  assert.equal(result.blob.source_file_id, "file_123");
});

test("ingestUploadedFileToDocument surfaces UploadThing upload failures", async () => {
  const fileRef: UploadedFileRef = {
    id: "file_1",
    name: "a.txt",
    mime_type: "text/plain",
    download_link: "https://example.com/a.txt",
  };

  await assert.rejects(
    ingestUploadedFileToDocument(
      fileRef,
      auth,
      undefined,
      {
        fetchBuffer: async () => Buffer.from("hello"),
        uploadBlob: async () => {
          throw new Error("UploadThing upload failed");
        },
        toText: async () => "hello",
        stashBlobDocument: async () => {
          throw new Error("should not run");
        },
      }
    ),
    /UploadThing upload failed/
  );
});

test("ingestUploadedFileToDocument rejects empty parsed content", async () => {
  const fileRef: UploadedFileRef = {
    id: "file_2",
    name: "empty.pdf",
    mime_type: "application/pdf",
    download_link: "https://example.com/empty.pdf",
  };

  await assert.rejects(
    ingestUploadedFileToDocument(
      fileRef,
      auth,
      undefined,
      {
        fetchBuffer: async () => Buffer.from("pdf"),
        uploadBlob: async () => ({ provider: "uploadthing", key: "k", url: "https://utfs.io/f/k" }),
        toText: async () => "   ",
        stashBlobDocument: async () => {
          throw new Error("should not run");
        },
      }
    ),
    /Empty content after parsing/
  );
});

test("ingestUploadedFilesToDocuments returns mixed success and errors", async () => {
  const refs: UploadedFileRef[] = [
    { id: "ok-1", name: "ok.txt", mime_type: "text/plain", download_link: "https://example.com/ok.txt" },
    { id: "bad-1", name: "bad.txt", mime_type: "text/plain", download_link: "https://example.com/bad.txt" },
  ];

  const result = await ingestUploadedFilesToDocuments(
    refs,
    auth,
    { conversation_id: "conv-mixed" },
    {
      fetchBuffer: async (ref) => Buffer.from(ref.id),
      uploadBlob: async (input) => {
        if (input.filename === "bad.txt") throw new Error("blob upload failed");
        return { provider: "uploadthing", key: "k1", url: "https://utfs.io/f/k1" };
      },
      toText: async () => "text",
      stashBlobDocument: async (_content, _auth, opts) => ({
        refHandle: "@doc:mixed-ok",
        status: "pending",
        conversationId: opts.conversationId ?? null,
        blob: opts.blob ?? null,
      }),
    }
  );

  assert.equal(result.saved.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.saved[0]?.conversation_id, "conv-mixed");
  assert.equal(result.errors[0]?.file_id, "bad-1");
  assert.match(result.errors[0]?.error ?? "", /blob upload failed/);
});

test("file type helpers detect pdf and word formats", () => {
  assert.equal(isPdfLikeFile({
    id: "p1",
    name: "report.PDF",
    mime_type: null,
    download_link: "https://example.com/report.pdf",
  }), true);

  assert.equal(isDocxLikeFile({
    id: "w1",
    name: "notes.docx",
    mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    download_link: "https://example.com/notes.docx",
  }), true);

  assert.equal(isLegacyDocFile({
    id: "w2",
    name: "legacy.doc",
    mime_type: "application/msword",
    download_link: "https://example.com/legacy.doc",
  }), true);

  assert.equal(isImageLikeFile({
    id: "img1",
    name: "diagram.png",
    mime_type: "image/png",
    download_link: "https://example.com/diagram.png",
  }), true);
});

test("uploadedFileToText rejects image files", async () => {
  await assert.rejects(
    uploadedFileToText(
      {
        id: "img2",
        name: "chart.png",
        mime_type: "image/png",
        download_link: "https://example.com/chart.png",
      },
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    ),
    /Image files are not supported for document ingest/i
  );
});

test("uploadedFileToText rejects non-pdf/docx text files", async () => {
  await assert.rejects(
    uploadedFileToText(
      {
        id: "txt1",
        name: "notes.txt",
        mime_type: "text/plain",
        download_link: "https://example.com/notes.txt",
      },
      Buffer.from("plain text")
    ),
    /Only PDF and Word \(\.docx\/\.docm\) files are supported/i
  );
});
