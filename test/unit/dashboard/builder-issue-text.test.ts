import assert from "node:assert/strict";
import test from "node:test";

test("maskBuilderIssueText hides raw technical errors", async () => {
  const { BUILDER_ISSUE_SUMMARY, maskBuilderIssueText, stripTechnicalLinesFromText } = await import(
    "../../../dashboard/src/lib/builder-issue-text.ts?t=mask"
  );

  assert.equal(
    maskBuilderIssueText(
      'insert or update on table "loop_agent_avatars" violates foreign key constraint',
      { log: false },
    ),
    BUILDER_ISSUE_SUMMARY,
  );
  assert.equal(
    maskBuilderIssueText(
      "ERROR Invalid input for tool `getAvailableTools`: JSON parsing failed",
      { log: false },
    ),
    BUILDER_ISSUE_SUMMARY,
  );
  assert.equal(
    stripTechnicalLinesFromText(
      "All good.\ninsert or update on table \"loop_agent_avatars\" violates foreign key constraint",
      { log: false },
    ),
    "All good.",
  );
});

test("logMaskedBuilderIssue dedupes identical context+message", async () => {
  const { logMaskedBuilderIssue } = await import(
    "../../../dashboard/src/lib/builder-issue-text.ts?t=dedupe"
  );

  const originalWarn = console.warn;
  let warnCount = 0;
  console.warn = () => {
    warnCount += 1;
  };

  try {
    logMaskedBuilderIssue("duplicate error", "test");
    logMaskedBuilderIssue("duplicate error", "test");
    assert.equal(warnCount, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("maskBuilderIssueText keeps curated user-facing recovery copy", async () => {
  const { isBuilderUserFacingIssueText, maskBuilderIssueText } = await import(
    "../../../dashboard/src/lib/builder-issue-text.ts?t=friendly"
  );

  const friendly = "Saving your loop timed out due to a temporary backend issue on our side.";
  assert.equal(maskBuilderIssueText(friendly, { log: false }), friendly);
  assert.equal(isBuilderUserFacingIssueText(friendly), true);
});
