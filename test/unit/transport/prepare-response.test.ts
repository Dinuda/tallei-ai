import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import { loadConfig } from "../../../src/config/load.js";
import {
  executePrepareResponseAction,
  fastPrepareResponseIntent,
  parsePrepareResponseIntent,
  type PrepareResponseIntent,
} from "../../../src/transport/shared/chat-actions.js";

const auth: AuthContext = {
  userId: "user_1",
  tenantId: "tenant_1",
  authMode: "api_key",
  plan: "pro",
  keyId: "key_1",
  connectorType: "chatgpt",
};

const recallBody = {
  contextBlock: "--- Your Past Context ---\n[CHATGPT:high] remembered context\n---",
  memories: [{ id: "mem_1", text: "remembered context", score: 0.9, metadata: {} }],
  recentDocuments: [],
  matchedDocuments: [],
  referencedDocuments: [],
  recentCompletedIngests: [],
  autoSave: {
    requested: 0,
    complete: true,
    saved: [],
    errors: [],
  },
};

const noSaveIntent: PrepareResponseIntent = {
  needsRecall: true,
  needsDocumentLookup: false,
  reusePreviousContext: false,
  contextDependent: true,
  saveCandidates: [],
};

const baseConfigEnv = {
  NODE_ENV: "test",
  TALLEI_HTTP__INTERNAL_API_SECRET: "secret",
  TALLEI_DB__URL: "postgresql://user:pass@localhost:5432/tallei",
  TALLEI_AUTH__JWT_SECRET: "jwt-secret",
};

test("intent classifier model defaults to gpt-5-nano and supports env override", () => {
  assert.equal(loadConfig(baseConfigEnv).intentClassifierModel, "gpt-5-nano");
  assert.equal(
    loadConfig({
      ...baseConfigEnv,
      TALLEI_LLM__INTENT_CLASSIFIER_MODEL: "gpt-4.1-nano",
    }).intentClassifierModel,
    "gpt-4.1-nano"
  );
  assert.equal(
    loadConfig({
      ...baseConfigEnv,
      INTENT_CLASSIFIER_MODEL: "gpt-4.1-nano-2025-04-14",
    }).intentClassifierModel,
    "gpt-4.1-nano-2025-04-14"
  );
});

test("parsePrepareResponseIntent accepts valid classifier JSON", () => {
  const parsed = parsePrepareResponseIntent(JSON.stringify({
    needsRecall: true,
    needsDocumentLookup: false,
    reusePreviousContext: false,
    contextDependent: true,
    saveCandidates: [
      { kind: "preference", content: "User prefers concise answers.", category: "communication" },
    ],
  }));

  assert.equal(parsed?.needsRecall, true);
  assert.equal(parsed?.saveCandidates[0]?.kind, "preference");
  assert.equal(parsed?.saveCandidates[0]?.content, "User prefers concise answers.");
});

test("parsePrepareResponseIntent returns null for malformed classifier JSON", () => {
  assert.equal(parsePrepareResponseIntent("not-json"), null);
});

test("fastPrepareResponseIntent skips classifier for local follow-ups with prior context", () => {
  const decision = fastPrepareResponseIntent({
    message: "yes, continue",
    last_recall: { query: "previous context" },
  });

  assert.equal(decision.shouldCallClassifier, false);
  assert.equal(decision.intent.needsRecall, false);
  assert.equal(decision.intent.reusePreviousContext, true);
});

test("fastPrepareResponseIntent skips classifier and queues sanitized opinion candidates", () => {
  const decision = fastPrepareResponseIntent({
    message: "i really think the government of sri lankan need to get a hand on their peeol. thees emfs are dumb",
  });

  assert.equal(decision.shouldCallClassifier, false);
  assert.equal(decision.intent.needsRecall, false);
  assert.deepEqual(decision.intent.saveCandidates, [
    {
      kind: "fact",
      content: "User is frustrated with governance in Sri Lanka and believes the government should manage civic behavior more effectively.",
    },
  ]);
});

test("fastPrepareResponseIntent still uses classifier for uncertain prompts", () => {
  const decision = fastPrepareResponseIntent({ message: "what do you think about this?" });

  assert.equal(decision.shouldCallClassifier, true);
});

test("fastPrepareResponseIntent treats product catalogue questions as retrieval plus child-age save", () => {
  const decision = fastPrepareResponseIntent({
    message: "can you tell me about the product catalogue? what can i get for my son? who is 5",
  });

  assert.equal(decision.shouldCallClassifier, false);
  assert.equal(decision.intent.needsRecall, true);
  assert.equal(decision.intent.needsDocumentLookup, true);
  assert.deepEqual(decision.intent.saveCandidates, [
    { kind: "fact", content: "User has a 5-year-old son." },
  ]);
});

test("executePrepareResponseAction handles product catalogue prompt without classifier and saves son age", async () => {
  let classifierCount = 0;
  let recallCount = 0;
  const queued: Array<() => Promise<void>> = [];
  const result = await executePrepareResponseAction(auth, {
    message: "can you tell me about the product catalogue? what can i get for my son? who is 5",
  }, {
    classifyIntent: async () => {
      classifierCount += 1;
      return noSaveIntent;
    },
    recallAction: async () => {
      recallCount += 1;
      return { status: 200, body: recallBody };
    },
    enqueueSave: (task) => {
      queued.push(task);
    },
  });

  assert.equal(result.status, 200);
  assert.equal(classifierCount, 0);
  assert.equal(recallCount, 1);
  assert.equal(queued.length, 1);
  assert.deepEqual(result.body.queuedSaves, [
    { kind: "fact", content: "User has a 5-year-old son.", status: "queued" },
  ]);
});

test("executePrepareResponseAction calls recall when intent requires recall", async () => {
  let recallCount = 0;
  const result = await executePrepareResponseAction(auth, { message: "What did we decide?" }, {
    classifyIntent: async () => noSaveIntent,
    recallAction: async () => {
      recallCount += 1;
      return { status: 200, body: recallBody };
    },
  });

  assert.equal(result.status, 200);
  assert.equal(recallCount, 1);
  assert.equal(result.body.contextBlock, recallBody.contextBlock);
});

test("executePrepareResponseAction broadens recall once when first recall is weak", async () => {
  const queries: string[] = [];
  const result = await executePrepareResponseAction(auth, { message: "What was the important decision?" }, {
    classifyIntent: async () => noSaveIntent,
    recallAction: async (_auth, input) => {
      queries.push(input.query);
      if (queries.length === 1) {
        return {
          status: 200,
          body: {
            ...recallBody,
            contextBlock: "--- No relevant memories found ---",
            memories: [],
            matchedDocuments: [],
          },
        };
      }
      return { status: 200, body: recallBody };
    },
  });

  assert.equal(result.status, 200);
  assert.equal(queries.length, 2);
  assert.match(queries[1], /Broaden search/);
  assert.equal(result.body.memories.length, 1);
});

test("executePrepareResponseAction queues save candidates without running them inline", async () => {
  const queued: Array<() => Promise<void>> = [];
  const result = await executePrepareResponseAction(auth, { message: "I prefer short answers." }, {
    classifyIntent: async () => ({
      ...noSaveIntent,
      saveCandidates: [{ kind: "preference", content: "User prefers short answers." }],
    }),
    recallAction: async () => ({ status: 200, body: recallBody }),
    rememberAction: async () => {
      throw new Error("remember should be queued, not called inline");
    },
    enqueueSave: (task) => {
      queued.push(task);
    },
  });

  assert.equal(result.status, 200);
  assert.equal(queued.length, 1);
  assert.deepEqual(result.body.queuedSaves, [
    { kind: "preference", content: "User prefers short answers.", status: "queued" },
  ]);
});

test("executePrepareResponseAction queues sanitized durable opinion memory even when recall is skipped", async () => {
  const queued: Array<() => Promise<void>> = [];
  let recallCount = 0;
  const result = await executePrepareResponseAction(auth, {
    message: "i really think the government of sri lankan need to get a hand on their peeol. thees emfs are dumb",
    last_recall: { query: "already prepared context" },
  }, {
    classifyIntent: async () => ({
      needsRecall: false,
      needsDocumentLookup: false,
      reusePreviousContext: true,
      contextDependent: false,
      saveCandidates: [],
    }),
    recallAction: async () => {
      recallCount += 1;
      return { status: 200, body: recallBody };
    },
    enqueueSave: (task) => {
      queued.push(task);
    },
  });

  assert.equal(result.status, 200);
  assert.equal(recallCount, 0);
  assert.equal(queued.length, 1);
  assert.deepEqual(result.body.queuedSaves, [
    {
      kind: "fact",
      content: "User is frustrated with governance in Sri Lanka and believes the government should manage civic behavior more effectively.",
      status: "queued",
    },
  ]);
  assert.deepEqual(result.body.intent.saveCandidates, [
    {
      kind: "fact",
      content: "User is frustrated with governance in Sri Lanka and believes the government should manage civic behavior more effectively.",
    },
  ]);
});

test("executePrepareResponseAction can reuse previous context and skip recall", async () => {
  let recallCount = 0;
  let classifierCount = 0;
  const result = await executePrepareResponseAction(auth, {
    message: "yes, continue with that",
    last_recall: { query: "previous context" },
  }, {
    classifyIntent: async () => {
      classifierCount += 1;
      return noSaveIntent;
    },
    recallAction: async () => {
      recallCount += 1;
      return { status: 200, body: recallBody };
    },
  });

  assert.equal(result.status, 200);
  assert.equal(recallCount, 0);
  assert.equal(classifierCount, 0);
  assert.match(result.body.contextBlock, /No relevant memories found/);
  assert.ok(result.body.replyInstructions.some((line) => /source of truth/.test(line)));
});

test("executePrepareResponseAction propagates uploaded file autosave refs", async () => {
  const result = await executePrepareResponseAction(auth, {
    message: "Summarize this report",
    openaiFileIdRefs: [{
      id: "file_1",
      name: "report.pdf",
      mime_type: "application/pdf",
      download_link: "https://files.example/report.pdf",
    }],
    conversation_id: "conv_1",
  }, {
    classifyIntent: async () => ({ ...noSaveIntent, needsRecall: false }),
    recallAction: async (_auth, input) => {
      assert.equal(input.openaiFileIdRefs?.length, 1);
      return {
        status: 200,
        body: {
          ...recallBody,
          autoSave: {
            requested: 1,
            complete: true,
            saved: [{ ref: "@doc:abc", status: "pending", filename: "report.pdf", conversation_id: "conv_1" }],
            errors: [],
          },
        },
      };
    },
  });

  assert.equal(result.body.autoSave.saved[0]?.ref, "@doc:abc");
  assert.ok(result.body.replyInstructions.some((line) => line.includes("Saved: @doc:abc")));
});
