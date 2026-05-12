import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import {
  createRequestTimingStore,
  currentRequestTimingStore,
  runWithRequestTimingStore,
} from "../../../src/observability/request-timing.js";

process.env.TALLEI_HTTP__INTERNAL_API_SECRET ??= "test-internal-secret";
process.env.TALLEI_DB__URL ??= "postgresql://test:test@localhost:5432/test";
process.env.TALLEI_AUTH__JWT_SECRET ??= "test-jwt-secret";
process.env.TALLEI_FEATURE__VERTEX_DOCUMENT_SEARCH = "true";
process.env.TALLEI_FEATURE__VERTEX_DOCUMENT_SEARCH_SHADOW = "false";
process.env.TALLEI_VERTEX_SEARCH__DATA_STORE =
  "projects/479839439487/locations/global/collections/default_collection/dataStores/tallei-store_1778518523112";
process.env.TALLEI_VERTEX_SEARCH__SERVING_CONFIG =
  "projects/479839439487/locations/global/collections/default_collection/engines/tallei_1778518418835/servingConfigs/default_search";
process.env.TALLEI_GOOGLE__PROJECT_ID = "actionlog-487112";

const { VertexDocumentSearchRepository } = await import(
  "../../../src/infrastructure/repositories/document-search.repository.js"
);

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "user-a",
    tenantId: "tenant-a",
    authMode: "oauth",
    plan: "pro",
    connectorType: "agent_engine",
    ...overrides,
  };
}

test("searchDocuments applies tenant/user filter and returns only scoped hits", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = (async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        results: [
          {
            id: "doc-visible",
            document: {
              id: "doc-visible",
              structData: {
                tenant_id: "tenant-a",
                user_id: "user-a",
                ref: "@doc:visible",
                title: "Visible Doc",
                summary: "Visible summary",
              },
              derivedStructData: {
                snippets: [{ snippet: "<b>Visible</b> snippet" }],
              },
            },
            modelScores: {
              score: { values: [0.92] },
            },
          },
          {
            id: "doc-other-tenant",
            document: {
              id: "doc-other-tenant",
              structData: {
                tenant_id: "tenant-b",
                user_id: "user-a",
                ref: "@doc:other",
                title: "Should Not Leak",
              },
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const repo = new VertexDocumentSearchRepository({
    fetchImpl,
    accessTokenProvider: async () => "test-token",
  });

  const hits = await repo.searchDocuments("pricing", auth(), 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.ref, "@doc:visible");
  assert.equal(hits[0]?.title, "Visible Doc");
  assert.equal(hits[0]?.score, 0.92);
  assert.equal(hits[0]?.preview, "Visible snippet");

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.ok(call.url.endsWith("/servingConfigs/default_search:search"));
  const headers = (call.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer test-token");
  assert.equal(headers["x-goog-user-project"], "actionlog-487112");

  const body = JSON.parse((call.init?.body as string) ?? "{}") as Record<string, unknown>;
  assert.equal(body["pageSize"], 5);
  assert.match(String(body["filter"]), /tenant_id: ANY/);
  assert.match(String(body["filter"]), /user_id: ANY/);
  assert.doesNotMatch(String(body["filter"]), /structData\./);
  assert.ok(String(body["branch"]).includes("/dataStores/tallei-store_1778518523112/branches/default_branch"));
});

test("indexDocument creates documents with scoped metadata and searchable content", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = (async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ name: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const repo = new VertexDocumentSearchRepository({
    fetchImpl,
    accessTokenProvider: async () => "test-token",
  });

  const store = createRequestTimingStore();
  await runWithRequestTimingStore(store, async () => {
    await repo.indexDocument({
      auth: auth(),
      documentId: "dbf5f4e4-4dbd-43dd-8407-cc821deec1b9",
      ref: "@doc:pricing-x1y2",
      title: "Pricing Notes",
      content: "We changed plan pricing for enterprise accounts.",
      summary: {
        summary: "Pricing update",
        keyPoints: ["Enterprise pricing changed"],
      },
      createdAt: "2026-05-12T00:00:00.000Z",
    });
    const fields = currentRequestTimingStore()?.fields ?? {};
    assert.equal(fields["vertex_document_index_status"], "success");
    assert.equal(fields["vertex_document_index_chunks"], 1);
    assert.equal(typeof fields["vertex_document_index_ms"], "number");
  });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.match(call.url, /\/documents\?documentId=dbf5f4e4-4dbd-43dd-8407-cc821deec1b9--c-0001$/);
  const body = JSON.parse((call.init?.body as string) ?? "{}") as Record<string, unknown>;
  const structData = body["structData"] as Record<string, unknown>;
  assert.equal(structData["tenant_id"], "tenant-a");
  assert.equal(structData["user_id"], "user-a");
  assert.equal(structData["doc_id"], "dbf5f4e4-4dbd-43dd-8407-cc821deec1b9");
  assert.equal(structData["chunk_index"], 1);
  assert.equal(structData["chunk_total"], 1);
  assert.equal(structData["ref"], "@doc:pricing-x1y2");

  const content = body["content"] as Record<string, string>;
  assert.equal(content["mimeType"], "text/plain");
  const raw = Buffer.from(content["rawBytes"], "base64").toString("utf8");
  assert.match(raw, /Pricing Notes/);
  assert.match(raw, /enterprise accounts/);
});

test("indexDocument updates document when it already exists", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = (async (input, init) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({ error: { message: "ALREADY_EXISTS" } }),
        { status: 409, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ name: "updated" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const repo = new VertexDocumentSearchRepository({
    fetchImpl,
    accessTokenProvider: async () => "test-token",
  });

  await repo.indexDocument({
    auth: auth(),
    documentId: "2ad08f28-7d44-495e-9779-06d59f399228",
    ref: "@doc:update-z9",
    title: "Update Target",
    content: "Document body",
    summary: {},
    createdAt: "2026-05-12T00:00:00.000Z",
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /\/documents\?documentId=2ad08f28-7d44-495e-9779-06d59f399228--c-0001$/);
  assert.match(calls[1]!.url, /\/documents\/2ad08f28-7d44-495e-9779-06d59f399228--c-0001\?updateMask=structData,content$/);
});

test("searchDocuments records latency timing field", async () => {
  const fetchImpl: typeof fetch = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 12));
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const repo = new VertexDocumentSearchRepository({
    fetchImpl,
    accessTokenProvider: async () => "test-token",
  });
  const store = createRequestTimingStore();

  await runWithRequestTimingStore(store, async () => {
    const hits = await repo.searchDocuments("latency check", auth(), 4);
    assert.deepEqual(hits, []);
    const fields = currentRequestTimingStore()?.fields ?? {};
    assert.equal(fields["vertex_document_search_status"], "success");
    assert.equal(typeof fields["vertex_document_search_ms"], "number");
    assert.ok(Number(fields["vertex_document_search_ms"]) >= 10);
  });
});
