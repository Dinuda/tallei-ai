import assert from "node:assert/strict";
import test from "node:test";

import { contactsToCsv, parseContactListCsv, parseContactListText } from "../../../src/services/conductor/workflow/csv-parser.js";

test("parseContactListCsv parses headered csv", () => {
  const contacts = parseContactListCsv("email,name\nalice@example.com,Alice\nbob@example.com,Bob");
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0]?.email, "alice@example.com");
  assert.equal(contacts[0]?.name, "Alice");
});

test("parseContactListCsv dedupes emails", () => {
  const contacts = parseContactListCsv("email\nalice@example.com\nalice@example.com\nbob@example.com");
  assert.equal(contacts.length, 2);
});

test("parseContactListText parses one email per line", () => {
  const contacts = parseContactListText("alice@example.com\nbob@example.com");
  assert.equal(contacts.length, 2);
});

test("contactsToCsv round-trips headered csv", () => {
  const contacts = [{ email: "alice@example.com", name: "Alice" }];
  const csv = contactsToCsv(contacts);
  const parsed = parseContactListCsv(csv);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.email, "alice@example.com");
  assert.equal(parsed[0]?.name, "Alice");
});

test("parseContactListCsv rejects empty input", () => {
  assert.throws(() => parseContactListCsv(""), /empty/i);
  assert.throws(() => parseContactListCsv("not-an-email"), /no valid email/i);
});
