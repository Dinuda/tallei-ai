import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenApiSpec } from "../../../src/transport/http/routes/chatgpt.js";

function postOperation(spec: ReturnType<typeof buildOpenApiSpec>, path: string) {
  const op = spec.paths[path]?.post;
  assert.ok(op, `Missing POST operation for ${path}`);
  return op;
}

test("ChatGPT OpenAPI includes primary prepare_response action path", () => {
  const spec = buildOpenApiSpec("https://example.com");
  const prepare = postOperation(spec, "/api/chatgpt/actions/prepare_response");
  assert.equal(prepare.operationId, "prepare_response");
});

test("ChatGPT OpenAPI documents prepare_response as the primary before-answer action", () => {
  const spec = buildOpenApiSpec("https://example.com");
  const prepare = postOperation(spec, "/api/chatgpt/actions/prepare_response");
  const recall = postOperation(spec, "/api/chatgpt/actions/recall_memories");
  const upload = postOperation(spec, "/api/chatgpt/actions/upload_blob");
  const remember = postOperation(spec, "/api/chatgpt/actions/remember");
  const recallDocument = postOperation(spec, "/api/chatgpt/actions/recall_document");

  assert.match(prepare.summary ?? "", /PRIMARY ACTION/i);
  assert.match(prepare.description ?? "", /durable facts, opinions, beliefs, preferences/i);
  assert.equal(prepare.requestBody?.required, true);
  assert.deepEqual(
    prepare.requestBody?.content?.["application/json"]?.schema?.required,
    ["message"]
  );
  assert.match(recall.summary ?? "", /Fallback/i);
  assert.match(recall.description ?? "", /prepare_response/i);
  assert.match(upload.description ?? "", /supports only PDF and Word/i);
  assert.match(upload.description ?? "", /\.docx\/\.docm/i);
  assert.match(spec.paths["/api/chatgpt/actions/upload_status"]?.get?.description ?? "", /handoff/i);
  assert.match(upload.description ?? "", /retry once/i);
  assert.match(remember.summary ?? "", /Fallback/i);
  assert.match(remember.description ?? "", /prepare_response/i);
  assert.match(recallDocument.description ?? "", /full document text/i);
  assert.match(spec.info.description ?? "", /Selective contract/i);
  assert.match(spec.info.description ?? "", /durable facts\/opinions\/preferences\/goals\/decisions/i);
});

test("ChatGPT OpenAPI operation descriptions stay within provider limits", () => {
  const spec = buildOpenApiSpec("https://example.com");
  const maxDescriptionLength = 300;
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!operation || typeof operation !== "object") continue;
      const description = (operation as { description?: string }).description;
      if (typeof description !== "string") continue;
      assert.ok(
        description.length <= maxDescriptionLength,
        `${method.toUpperCase()} ${path} description length ${description.length} exceeds ${maxDescriptionLength}`
      );
    }
  }
});
