import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const chatGptRoutePath = path.join(process.cwd(), "src/transport/http/routes/chatgpt.ts");

test("ChatGPT OpenAPI includes upload_blob action path", () => {
  const content = readFileSync(chatGptRoutePath, "utf8");
  assert.match(content, /"\/api\/chatgpt\/actions\/upload_blob"/);
  assert.match(content, /operationId: "upload_blob"/);
});

test("ChatGPT OpenAPI documents strict upload-first tool order", () => {
  const content = readFileSync(chatGptRoutePath, "utf8");
  assert.match(content, /Call on the first user turn in a chat/);
  assert.match(content, /For uploads: upload_blob \(wait\), then recall_memories if needed, then answer/);
  assert.match(content, /OpenAPI operation descriptions are the canonical execution contract/);
});
