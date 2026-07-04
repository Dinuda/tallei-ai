import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../../dashboard/src/components/conductor/conductor-tool-part.tsx", import.meta.url),
  "utf8",
);

test("binding diagnostics are visible with expandable technical details", () => {
  assert.match(source, /Binding setup needs attention/);
  assert.match(source, /Technical details/);
  assert.match(source, /visibleDiagnostics/);
  assert.match(source, /BindingDiagnosticsCard/);
  assert.match(source, /Binding issue resolved/);
});

test("binding diagnostic technical details redact secret-like fields", () => {
  assert.match(source, /token\|secret\|password\|credential\|authorization\|cookie\|api\.\?key/);
  assert.match(source, /\[REDACTED\]/);
});
