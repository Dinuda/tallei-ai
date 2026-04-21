import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenApiSpec } from "../../../src/transport/http/routes/chatgpt.js";

function postOperation(spec: ReturnType<typeof buildOpenApiSpec>, path: string) {
  const op = spec.paths[path]?.post;
  assert.ok(op, `Missing POST operation for ${path}`);
  return op;
}

test("ChatGPT OpenAPI includes upload_blob action path", () => {
  const spec = buildOpenApiSpec("https://example.com");
  const upload = postOperation(spec, "/api/chatgpt/actions/upload_blob");
  assert.equal(upload.operationId, "upload_blob");
});

test("ChatGPT OpenAPI documents strict upload/recall/save non-negotiables", () => {
  const spec = buildOpenApiSpec("https://example.com");
  const recall = postOperation(spec, "/api/chatgpt/actions/recall_memories");
  const upload = postOperation(spec, "/api/chatgpt/actions/upload_blob");
  const remember = postOperation(spec, "/api/chatgpt/actions/remember");

  assert.match(recall.description ?? "", /first user turn must call this/i);
  assert.match(recall.description ?? "", /upload_blob \(wait\)/i);
  assert.match(upload.description ?? "", /I'm saving "<file_name>"/);
  assert.match(upload.description ?? "", /end with saved @doc\/@lot link/i);
  assert.match(remember.description ?? "", /every 3 user messages/i);
  assert.match(spec.info.description ?? "", /canonical execution contract/i);
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
