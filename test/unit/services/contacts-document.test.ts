import assert from "node:assert/strict";
import test from "node:test";

import { contactsToCsv } from "../../../src/services/conductor/workflow/csv-parser.js";

test("contactsToCsv escapes commas in names", () => {
  const csv = contactsToCsv([{ email: "a@example.com", name: "Doe, Jane" }]);
  assert.match(csv, /"Doe, Jane"/);
});
