import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import {
  executeRecallAction,
  executeRememberAction,
  executeUploadBlobAction,
} from "../../../src/transport/shared/chat-actions.js";

const auth: AuthContext = {
  userId: "u_validation",
  tenantId: "t_validation",
  authMode: "internal",
  plan: "pro",
};

test("executeRecallAction rejects unsupported upload formats before ingest", async () => {
  const result = await executeRecallAction(auth, {
    query: "summarize this",
    limit: 5,
    openaiFileIdRefs: [
      {
        id: "file_txt",
        name: "notes.txt",
        mime_type: "text/plain",
        download_link: "https://example.com/notes.txt",
      },
    ],
  });

  assert.equal(result.status, 422);
  assert.match(result.body.error, /unsupported formats/i);
  assert.equal(result.body.autoSave.saved.length, 0);
  assert.equal(result.body.autoSave.errors.length, 1);
  assert.match(result.body.autoSave.errors[0]?.error ?? "", /Only PDF and Word/i);
});

test("executeUploadBlobAction rejects unsupported upload formats before enqueue", async () => {
  const result = await executeUploadBlobAction(auth, {
    openaiFileIdRefs: [
      {
        id: "file_png",
        name: "image.png",
        mime_type: "image/png",
        download_link: "https://example.com/image.png",
      },
    ],
  });

  assert.equal(result.status, 422);
  assert.equal(result.body.count_saved, 0);
  assert.equal(result.body.count_failed, 1);
  assert.equal((result.body.errors as unknown[]).length, 1);
});

test("executeRememberAction rejects unsupported upload formats before save", async () => {
  const result = await executeRememberAction(auth, {
    kind: "document-note",
    title: "bad upload",
    openaiFileIdRefs: [
      {
        id: "file_md",
        name: "readme.md",
        mime_type: "text/markdown",
        download_link: "https://example.com/readme.md",
      },
    ],
  });

  assert.equal(result.status, 422);
  assert.equal(result.body.count_saved, 0);
  assert.equal(result.body.count_failed, 1);
  assert.equal((result.body.saved as unknown[]).length, 0);
  assert.equal((result.body.errors as unknown[]).length, 1);
});
