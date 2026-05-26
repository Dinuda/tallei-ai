import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";

import {
  classifyZipEntryPath,
  inspectZipSkipStats,
  streamConversationsFromBulkFile,
  streamConversationsFromJsonFiles,
} from "../../../src/orchestration/memory/chatgpt-bulk-stream-ingest.js";
import {
  conversationRecordToBundle,
  isConversationWithinImportWindow,
} from "../../../src/orchestration/memory/chatgpt-bulk-parser.js";
import {
  buildStorageRef,
  resolveStoragePath,
} from "../../../src/services/chatgpt-import/storage.js";

process.env.TALLEI_IMPORT__STORAGE_DIR ??= join(tmpdir(), "tallei-import-tests");
process.env.TALLEI_IMPORT__MAX_AGE_DAYS ??= "365";

const RECENT_CONVERSATION = {
  title: "recent",
  create_time: Math.floor(Date.now() / 1000) - 86_400 * 30,
  current_node: "node_1",
  mapping: {
    node_1: {
      id: "node_1",
      parent: null,
      children: [],
      message: {
        id: "message_1",
        author: { role: "user" },
        content: {
          content_type: "text",
          parts: ["I prefer concise answers."],
        },
        create_time: Math.floor(Date.now() / 1000) - 86_400 * 30,
      },
    },
  },
};

const OLD_CONVERSATION = {
  ...RECENT_CONVERSATION,
  title: "old",
  create_time: Math.floor(Date.now() / 1000) - 86_400 * 500,
  mapping: {
    node_1: {
      ...RECENT_CONVERSATION.mapping.node_1,
      message: {
        ...RECENT_CONVERSATION.mapping.node_1.message,
        create_time: Math.floor(Date.now() / 1000) - 86_400 * 500,
      },
    },
  },
};

test("classifyZipEntryPath skips dat and media paths", () => {
  assert.equal(classifyZipEntryPath("file-abc.dat"), "dat");
  assert.equal(classifyZipEntryPath("dalle-generations/image.webp"), "media");
  assert.equal(classifyZipEntryPath("conversations.json"), "conversations");
  assert.equal(classifyZipEntryPath("user.json"), "profile");
});

test("isConversationWithinImportWindow rejects old dated conversations but includes all when maxAgeDays is null", () => {
  assert.equal(isConversationWithinImportWindow(RECENT_CONVERSATION, 365), true);
  assert.equal(isConversationWithinImportWindow(OLD_CONVERSATION, 365), false);
  assert.equal(isConversationWithinImportWindow(OLD_CONVERSATION, null), true);
  assert.equal(isConversationWithinImportWindow({ title: "no date" }, 365), false);
  assert.equal(isConversationWithinImportWindow({ title: "no date" }, null), false);
});

test("conversationRecordToBundle ignores image-only messages", () => {
  const bundle = conversationRecordToBundle({
    create_time: Math.floor(Date.now() / 1000),
    current_node: "node_1",
    mapping: {
      node_1: {
        id: "node_1",
        parent: null,
        children: [],
        message: {
          author: { role: "user" },
          content: {
            content_type: "image",
            parts: [],
          },
        },
      },
    },
  }, "conversations.json", 0);
  assert.equal(bundle, null);
});

test("streamConversationsFromBulkFile skips dat entries and old conversations in zip", async () => {
  const zip = new JSZip();
  zip.file("conversations.json", JSON.stringify([RECENT_CONVERSATION, OLD_CONVERSATION]));
  zip.file("noise.dat", Buffer.from([0, 1, 2, 3, 0, 5]));
  zip.file("photo.webp", Buffer.from("fake"));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });

  const dir = await mkdtemp(join(tmpdir(), "tallei-stream-ingest-"));
  const userId = "user-test";
  const storageRef = buildStorageRef(userId, "export.zip");
  const absolutePath = resolveStoragePath(storageRef);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, buffer);

  try {
    const stats = {
      skippedDatFiles: 0,
      skippedMediaFiles: 0,
      skippedOtherBinary: 0,
      skippedOldConversations: 0,
      parsedConversations: 0,
      hasConversationsJson: false,
      sourcesParsed: [] as string[],
    };
    const bundles = [];
    for await (const bundle of streamConversationsFromBulkFile(storageRef, { stats })) {
      bundles.push(bundle);
    }

    assert.equal(bundles.length, 1);
    assert.match(bundles[0]?.messages[0]?.text ?? "", /I prefer concise answers/);
    assert.equal(stats.skippedDatFiles, 1);
    assert.equal(stats.skippedMediaFiles, 1);
    assert.equal(stats.skippedOldConversations, 1);
    assert.equal(stats.hasConversationsJson, true);

    const inspected = await inspectZipSkipStats(absolutePath);
    assert.equal(inspected.skippedDatFiles, 1);
    assert.equal(inspected.skippedMediaFiles, 1);
  } finally {
    await rm(absolutePath, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("streamConversationsFromJsonFiles skips profile JSON and streams conversation shards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tallei-json-mixed-"));
  const userId = "user-mixed-json";
  const refs: string[] = [];

  const userRef = buildStorageRef(userId, "user.json");
  const userPath = resolveStoragePath(userRef);
  await mkdir(join(userPath, ".."), { recursive: true });
  await writeFile(userPath, JSON.stringify({ id: "user-1", email: "test@example.com" }));
  refs.push(userRef);

  const convoRef = buildStorageRef(userId, "conversations-000.json");
  const convoPath = resolveStoragePath(convoRef);
  await writeFile(convoPath, JSON.stringify([RECENT_CONVERSATION]));
  refs.push(convoRef);

  try {
    const bundles = [];
    for await (const bundle of streamConversationsFromJsonFiles(refs, { maxAgeDays: null })) {
      bundles.push(bundle);
    }
    assert.equal(bundles.length, 1);
  } finally {
    for (const storageRef of refs) {
      await rm(resolveStoragePath(storageRef), { force: true });
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("streamConversationsFromJsonFiles yields from multiple conversation JSON files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tallei-json-files-"));
  const userId = "user-multi-json";
  const refs: string[] = [];

  for (let index = 0; index < 3; index += 1) {
    const storageRef = buildStorageRef(userId, `conversations-${index}.json`);
    const absolutePath = resolveStoragePath(storageRef);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, JSON.stringify([{
      ...RECENT_CONVERSATION,
      title: `recent-${index}`,
    }]));
    refs.push(storageRef);
  }

  try {
    const bundles = [];
    for await (const bundle of streamConversationsFromJsonFiles(refs, { maxAgeDays: null })) {
      bundles.push(bundle);
    }
    assert.equal(bundles.length, 3);
  } finally {
    for (const storageRef of refs) {
      await rm(resolveStoragePath(storageRef), { force: true });
    }
    await rm(dir, { recursive: true, force: true });
  }
});
