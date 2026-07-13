import assert from "node:assert/strict";
import test from "node:test";

const CONVERSATION_JSON_FILENAME = /^conversations(?:-\d+)?\.json$/i;
const OPTIONAL_PROFILE_JSON_FILENAME = /^(shared_conversations|user|user_settings)\.json$/i;

function isConversationJsonImportFilename(filename: string): boolean {
  const base = filename.trim();
  return CONVERSATION_JSON_FILENAME.test(base) || OPTIONAL_PROFILE_JSON_FILENAME.test(base);
}

test("conversation JSON filename validator rejects zip and dat files", () => {
  assert.equal(isConversationJsonImportFilename("export.zip"), false);
  assert.equal(isConversationJsonImportFilename("file-abc.dat"), false);
  assert.equal(isConversationJsonImportFilename("conversations.json"), true);
  assert.equal(isConversationJsonImportFilename("conversations-029.json"), true);
  assert.equal(isConversationJsonImportFilename("shared_conversations.json"), true);
  assert.equal(isConversationJsonImportFilename("user.json"), true);
});
