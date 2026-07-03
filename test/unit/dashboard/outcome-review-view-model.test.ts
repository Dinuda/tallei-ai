import assert from "node:assert/strict";
import test from "node:test";

const { buildOutcomeReviewViewModel } = await import(
  "../../../dashboard/src/components/conductor/outcome-review-view-model.ts"
);

function baseSpec(): Record<string, unknown> {
  return {
    intent: {
      goal: "Keep records organized",
      outcome: "Records are classified and stored in the configured destination.",
    },
    trigger: { kind: "manual" },
    taskBlueprint: {
      version: 1,
      summary: "Classify and store records",
      outcomes: [
        { id: "source", role: "source", description: "Read new records", status: "chosen", selectedConnector: "alpha" },
        { id: "classify", role: "transform", description: "Classify each record", status: "chosen" },
        { id: "store", role: "destination", description: "Store the classified record", status: "chosen", selectedConnector: "beta" },
      ],
    },
    approval: { mode: "mixed", sensitiveRoles: ["destination"], sensitiveCapabilities: [] },
    output: { kind: "none" },
  };
}

test("buildOutcomeReviewViewModel derives title, stages, approval, and result from config", () => {
  const review = buildOutcomeReviewViewModel(baseSpec());
  assert.equal(review.title, "Classify and store records");
  assert.equal(review.runsWhen, "Starts when you run it.");
  assert.equal(review.does, "Records are classified and stored in the configured destination.");
  assert.deepEqual(review.stages.map((stage) => stage.kind), ["source", "action", "approval", "result"]);
  assert.deepEqual(review.stages.map((stage) => stage.identity), ["Alpha", "Tallei", "You", "Beta"]);
  assert.deepEqual(review.stages.map((stage) => stage.icon), ["alpha", undefined, undefined, "beta"]);
  assert.equal(review.reversible, true);
  assert.match(review.approval, /sensitive actions/i);
  assert.equal(review.result, "Store the classified record");
});

test("scheduled and event triggers use generic config-derived descriptions", () => {
  const scheduled = baseSpec();
  scheduled.trigger = { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" };
  assert.equal(buildOutcomeReviewViewModel(scheduled).runsWhen, "Runs on its configured schedule.");

  const event = baseSpec();
  event.trigger = { kind: "event", source: "custom_records", composioSlug: "CUSTOM_RECORD_CREATED" };
  assert.equal(buildOutcomeReviewViewModel(event).runsWhen, "Starts when an event arrives from Custom Records.");
});

test("configured trigger outcome takes precedence over technical trigger config", () => {
  const spec = baseSpec();
  spec.trigger = { kind: "event", source: "internal_system", composioSlug: "INTERNAL_EVENT" };
  const blueprint = spec.taskBlueprint as { outcomes: Array<Record<string, unknown>> };
  blueprint.outcomes.unshift({ id: "trigger", role: "trigger", description: "When a reviewed record becomes available", status: "chosen", selectedConnector: "custom" });
  assert.equal(buildOutcomeReviewViewModel(spec).runsWhen, "When a reviewed record becomes available");
});

test("trigger outcomes mask connector identity as Trigger while keeping connector icon", () => {
  const spec = baseSpec();
  const blueprint = spec.taskBlueprint as { outcomes: Array<Record<string, unknown>> };
  blueprint.outcomes.unshift({
    id: "trigger",
    role: "trigger",
    description: "When a new support ticket arrives",
    status: "chosen",
    selectedConnector: "gmail",
  });
  const review = buildOutcomeReviewViewModel(spec);
  const triggerStage = review.stages[0];
  assert.equal(triggerStage?.kind, "trigger");
  assert.equal(triggerStage?.identity, "Trigger");
  assert.equal(triggerStage?.label, "Starts when");
  assert.equal(triggerStage?.icon, "gmail");
  assert.equal(review.stages[1]?.identity, "Alpha");
});

test("auto approval is a direct action and does not add an approval stage", () => {
  const spec = baseSpec();
  spec.approval = { mode: "auto", sensitiveRoles: [], sensitiveCapabilities: [] };
  const review = buildOutcomeReviewViewModel(spec);
  assert.equal(review.reversible, false);
  assert.doesNotMatch(review.stages.map((stage) => stage.kind).join(","), /approval/);
  assert.match(review.approval, /automatically/i);
});

test("multiple transforms receive deterministic generic labels", () => {
  const spec = baseSpec();
  const blueprint = spec.taskBlueprint as { outcomes: Array<Record<string, unknown>> };
  blueprint.outcomes.splice(2, 0, { id: "validate", role: "transform", description: "Validate the classification", status: "chosen" });
  const actionLabels = buildOutcomeReviewViewModel(spec).stages
    .filter((stage) => stage.kind === "action")
    .map((stage) => stage.label);
  assert.deepEqual(actionLabels, ["Processes", "Processes 2"]);
});

test("incomplete config and missing output produce safe generic fallbacks", () => {
  const review = buildOutcomeReviewViewModel({
    intent: { goal: "Complete a task", outcome: "" },
    trigger: {},
    approval: { mode: "ask" },
    output: { kind: "none" },
  });
  assert.equal(review.title, "Complete a task");
  assert.equal(review.runsWhen, "Start condition is not configured yet.");
  assert.equal(review.stages.length, 1);
  assert.equal(review.stages[0]?.kind, "approval");
  assert.match(review.result, /remain in the apps/i);
});

test("legacy summary is used only when current spec is unavailable", () => {
  const legacy = {
    title: "Legacy plan",
    reversible: true,
    runsWhen: "Legacy trigger",
    does: "Legacy behavior",
    steps: [{ label: "Legacy", description: "Legacy stage", kind: "action" as const }],
    approval: "Legacy approval",
    result: "Legacy result",
  };
  assert.equal(buildOutcomeReviewViewModel(null, legacy).title, "Legacy plan");
  assert.notEqual(buildOutcomeReviewViewModel(baseSpec(), legacy).title, "Legacy plan");
});
