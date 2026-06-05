import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTemplateCatalogForPrompt,
  getLoopTemplate,
  listLoopTemplates,
} from "../../../src/services/loop-executor/templates/registry.js";

test("listLoopTemplates includes high-potential writing companion and newsletter broadcast", () => {
  const templates = listLoopTemplates();
  assert.ok(templates.length >= 2);
  const writing = getLoopTemplate("writing_companion");
  const newsletter = getLoopTemplate("newsletter_broadcast");
  assert.ok(writing?.highPotential);
  assert.ok(newsletter?.highPotential);
  assert.match(writing?.summary ?? "", /Memory Search/i);
  assert.match(newsletter?.summary ?? "", /broadcast/i);
});

test("formatTemplateCatalogForPrompt renders quality patterns without template IDs or HIGH-POTENTIAL labels", () => {
  const text = formatTemplateCatalogForPrompt();
  // Template IDs and HIGH-POTENTIAL labels must NOT appear in output (prevents model from copying them)
  assert.doesNotMatch(text, /HIGH-POTENTIAL/);
  assert.doesNotMatch(text, /writing_companion/);
  assert.doesNotMatch(text, /newsletter_broadcast/);
  // Must still include the practical content
  assert.match(text, /Pattern \d+/);
  assert.match(text, /Example roster/);
  assert.match(text, /memory_search/);
  // Broadcast delivery note must be present for the newsletter pattern
  assert.match(text, /subscribers\/mailing list/);
  assert.match(text, /presetId.*newsletter/);
});

test("getLoopTemplate returns null for unknown id", () => {
  assert.equal(getLoopTemplate("nonexistent"), null);
});
