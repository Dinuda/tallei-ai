import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import {
  ingestChatGptBulkFiles,
  ingestChatGptBulkFromBuffers,
} from "../../../src/orchestration/memory/chatgpt-bulk-ingest.js";
import { extractBulkMemoryCandidates } from "../../../src/orchestration/memory/chatgpt-bulk-parser.js";
import { parseChatGptImportInput } from "../../../src/orchestration/memory/chatgpt-import.usecase.js";

const CONVERSATION_FIXTURE = [
  {
    title: "preferences",
    current_node: "node_1",
    create_time: 1760000000,
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
            parts: ["I prefer concise answers.", "My timezone is UTC+5:30"],
          },
          create_time: 1760000000,
        },
      },
    },
  },
];

test("ingest skips binary .dat files inside zip", async () => {
  const zip = new JSZip();
  zip.file("file-abc123.dat", Buffer.from([0, 7, 13, 0, 255, 2]));
  zip.file("library_files.json", JSON.stringify({ files: [] }));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });

  const result = await ingestChatGptBulkFiles([{ name: "export.zip", buffer }]);
  assert.equal(result.documents.length, 2);
  assert.ok(result.documents.some((doc) => doc.role === "dat_metadata"));
  assert.ok(result.documents.some((doc) => doc.role === "library_catalog"));
  assert.equal(result.skipped.binaryDat, 1);
  assert.equal(result.dat.inspected, 1);
  assert.equal(result.dat.metadataOnly, 1);
  assert.equal(result.hasConversationsJson, false);
  assert.match(result.warnings.join(" "), /Inspected 1 \.dat file/);
});

test("ingest parses conversations.json from zip", async () => {
  const zip = new JSZip();
  zip.file("conversations.json", JSON.stringify(CONVERSATION_FIXTURE));
  zip.file("noise.dat", Buffer.from([0, 1, 2, 3, 0, 5]));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });

  const result = await ingestChatGptBulkFiles([{ name: "export.zip", buffer }]);
  assert.equal(result.hasConversationsJson, true);
  assert.deepEqual(result.sourcesParsed, ["conversations.json"]);
  assert.equal(result.skipped.binaryDat, 1);

  const parsed = extractBulkMemoryCandidates(result.documents);
  assert.ok(parsed.candidates.length >= 1);
  assert.match(parsed.candidates[0]?.text ?? "", /I prefer concise answers\./);
  assert.match(parsed.candidates[0]?.text ?? "", /My timezone is UTC\+5:30/);
});

test("bulk parser ignores code-like user lines when no memory-style cues exist", () => {
  const documents = [{
    path: "conversations.json",
    role: "conversations" as const,
    data: [{
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
              parts: [
                "import { DynamoDB } from 'aws-sdk';\nconst session = await stripe.checkout.sessions.create({",
              ],
            },
            create_time: 1760000000,
          },
        },
      },
    }],
  }];

  const parsed = extractBulkMemoryCandidates(documents);
  assert.equal(parsed.candidates.length, 0);
});

test("ingest handles shared_conversations.json without conversations.json", async () => {
  const result = await ingestChatGptBulkFromBuffers([
    {
      name: "shared_conversations.json",
      buffer: Buffer.from(JSON.stringify(CONVERSATION_FIXTURE), "utf8"),
    },
  ]);
  assert.equal(result.hasConversationsJson, false);
  assert.equal(result.sourcesParsed[0], "shared_conversations.json");
  assert.match(result.warnings.join(" "), /No conversations\.json/i);
});

test("bulk_export paste fallback skips binary-looking lines", () => {
  const parsed = parseChatGptImportInput("RIFFWAVEfmt \uFFFD\uFFFD\nI prefer concise answers.", {
    modeHint: "bulk_export",
  });
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0]?.raw, "I prefer concise answers.");
});
