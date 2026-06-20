import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = new URL("../../../src/transport/http/routes/loopBuilder.ts", import.meta.url);
const dispatcherPath = new URL("../../../src/services/loop-builder/dispatcher.ts", import.meta.url);
const builderPagePath = new URL("../../../dashboard/app/dashboard/loops/new/page.tsx", import.meta.url);
const creatorPath = new URL("../../../src/services/loop-executor/creator.ts", import.meta.url);
const verificationPath = new URL("../../../src/services/loop-executor/verification.ts", import.meta.url);
const specsPath = new URL("../../../src/services/loop-builder/specs.ts", import.meta.url);
const connectorAvailabilityPath = new URL("../../../src/services/connectors/availability.ts", import.meta.url);
const connectorServicePath = new URL("../../../src/services/connectors/composio.ts", import.meta.url);
const connectorChecklistPath = new URL("../../../dashboard/src/components/builder-connector-checklist.tsx", import.meta.url);
const appSelectorPath = new URL("../../../dashboard/src/components/builder-app-selector.tsx", import.meta.url);
const scheduleSelectorPath = new URL("../../../dashboard/src/components/builder-schedule-selector.tsx", import.meta.url);
const artifactStudioPath = new URL("../../../dashboard/src/components/email-artifact-studio.tsx", import.meta.url);
const builderArtifactEditorPath = new URL("../../../dashboard/src/components/builder-artifact-editor.tsx", import.meta.url);
const triggerWebhookPath = new URL("../../../src/services/loop-runtime/composio-trigger.ts", import.meta.url);
const connectorRoutePath = new URL("../../../src/transport/http/routes/connectors.ts", import.meta.url);

test("chat exposes real builder tools without synthetic intent tools", async () => {
  const [route, dispatcher] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(dispatcherPath, "utf8"),
  ]);

  assert.doesNotMatch(route, /nextChatCommand/);
  assert.doesNotMatch(dispatcher, /\|\s*"analyzeIntent"/);
  assert.doesNotMatch(dispatcher, /\|\s*"resolveClarifications"/);
  assert.match(dispatcher, /\|\s*"getAvailableTools"/);
  assert.match(dispatcher, /\|\s*"resolveBuildRequirement"/);
  assert.match(route, /resolveBuildRequirement:\s*tool\(/);
  assert.match(route, /approved:\s*true/);
});

test("option-based clarification uses the UI-only interactive prompt capability", async () => {
  const [route, dispatcher] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(dispatcherPath, "utf8"),
  ]);

  assert.match(route, /interactivePrompt:\s*tool\(/);
  assert.match(route, /including binary yes\/no questions/);
  assert.doesNotMatch(dispatcher, /\|\s*"interactivePrompt"/);
});

test("users select available apps before exact tool discovery", async () => {
  const [route, dispatcher, discovery, builderPage, appSelector] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(dispatcherPath, "utf8"),
    readFile(new URL("../../../src/services/connectors/composio-discovery.ts", import.meta.url), "utf8"),
    readFile(builderPagePath, "utf8"),
    readFile(appSelectorPath, "utf8"),
  ]);

  assert.match(route, /appSelection:\s*tool\(/);
  assert.match(route, /Never infer or silently select an app/);
  assert.match(route, /selectedToolkits:\s*z\.array/);
  assert.match(dispatcher, /Select at least one app before discovering tools/);
  assert.match(discovery, /composioToolkitSet\.has/);
  assert.match(builderPage, /BuilderAppSelector/);
  assert.match(appSelector, /\/api\/connectors\/composio\/toolkits/);
  assert.match(appSelector, /Use selected apps/);
});

test("required connectors use the inline connector checklist and a fresh availability session", async () => {
  const [route, dispatcher, availability, connectorService, builderPage, checklist] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(dispatcherPath, "utf8"),
    readFile(connectorAvailabilityPath, "utf8"),
    readFile(connectorServicePath, "utf8"),
    readFile(builderPagePath, "utf8"),
    readFile(connectorChecklistPath, "utf8"),
  ]);

  assert.match(route, /connectorSetup:\s*tool\(/);
  assert.match(route, /never use interactivePrompt for connector setup and never offer connect later/);
  assert.doesNotMatch(dispatcher, /\|\s*"connectorSetup"/);
  assert.match(dispatcher, /\|\s*"refreshConnectorAvailability"/);
  assert.match(availability, /invalidateComposioSession\(input\.previousComposioSessionId\)/);
  assert.match(availability, /const session = await createComposioSession\(input\.auth, connectedAccounts\)/);
  assert.match(availability, /reconcileComposioConnectorAccounts/);
  assert.match(availability, /isActionVisible\(contract, visibleSlugs\)/);
  assert.match(connectorService, /export async function resolveConnectedComposioAccountIds/);
  assert.match(connectorService, /preferredAuthConfigId/);
  assert.doesNotMatch(connectorService, /config\.composioAuthConfigId\s*\?\s*await createComposioConnectLink/);
  assert.doesNotMatch(connectorService, /verifiedExternalAccountId \|\| `acct_/);
  assert.match(availability, /connected_pending_action_visibility/);
  assert.match(builderPage, /BuilderConnectorChecklist/);
  assert.match(checklist, /Continuing\.\.\./);
  assert.match(checklist, /confirmConnectedApps/);
  assert.match(checklist, /What this loop can do with/);
  assert.doesNotMatch(checklist, /Give this account a name/);
  assert.doesNotMatch(checklist, /Choose an account/);
  assert.doesNotMatch(checklist, /Connect another account/);
  assert.doesNotMatch(checklist, /connectors\/selection/);
  assert.doesNotMatch(checklist, /connectors\/accounts/);
  assert.doesNotMatch(checklist, /unavailableActionSlugs\.join/);
  assert.doesNotMatch(checklist, /connect later/i);
});

test("free text resolves a dismissed interactive prompt before continuing", async () => {
  const builderPage = await readFile(builderPagePath, "utf8");

  assert.match(builderPage, /activePromptId === dismissedPromptId/);
  assert.match(builderPage, /state:\s*"output-available",\s*output:\s*answer\s*}\s*as ToolPart/);
  assert.match(builderPage, /otherText:\s*answerText/);
  assert.match(builderPage, /role:\s*"user",\s*parts:\s*\[\{ type:\s*"text",\s*text:\s*answerText \}\]/);
  assert.match(builderPage, /await sendMessage\(\)/);
});

test("spec drafting consumes persisted build contract without Composio discovery", async () => {
  const [specs, dispatcher] = await Promise.all([
    readFile(specsPath, "utf8"),
    readFile(dispatcherPath, "utf8"),
  ]);

  assert.doesNotMatch(specs, /discoverToolsForLoopBuild/);
  assert.match(specs, /loopBuildContractSchema\.parse\(input\.buildContract\)/);
  assert.match(specs, /buildContract,/);
  assert.match(specs, /exactMaxTokens:\s*true/);
  assert.match(specs, /emptyResponseRetryMaxTokens:\s*8192/);
  assert.match(specs, /reportLoopBuilderProgress\(\{\s*stage:\s*"spec_generation"/);
  assert.match(dispatcher, /ensureDraftedSpec/);
  assert.match(dispatcher, /draftLoopSpec\(/);
});

test("builder-created workflows remain unscheduled until verification is confirmed", async () => {
  const [route, dispatcher, creator, verification] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(dispatcherPath, "utf8"),
    readFile(creatorPath, "utf8"),
    readFile(verificationPath, "utf8"),
  ]);

  assert.match(dispatcher, /initialStatus:\s*"verifying"/);
  assert.match(dispatcher, /\|\s*"runVerification"/);
  assert.match(dispatcher, /\|\s*"confirmActivation"/);
  assert.match(route, /runVerification:\s*tool\(/);
  assert.match(route, /confirmActivation:\s*tool\(/);
  assert.match(creator, /initialStatus === "active" \? nextCronRunAt/);
  assert.match(verification, /status = 'active', next_run_at/);
  assert.match(verification, /warnings_json/);
  assert.match(verification, /dryRunLog/);
});

test("artifact contract uses the in-chat artifact composer", async () => {
  const [route, builderPage, artifactStudio, builderArtifactEditor] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(builderPagePath, "utf8"),
    readFile(artifactStudioPath, "utf8"),
    readFile(builderArtifactEditorPath, "utf8"),
  ]);

  assert.match(route, /artifactSetup:\s*tool\(/);
  assert.match(route, /call artifactSetup with draftTemplates entries/);
  assert.match(route, /dryRunLog steps and evidence/);
  assert.match(builderPage, /BuilderArtifactEditor/);
  assert.match(builderPage, /findActiveArtifactSetup/);
  assert.match(builderPage, /updateArtifactToolOutput/);
  assert.match(builderArtifactEditor, /EmailArtifactPreviewCard/);
  assert.match(artifactStudio, /Looks good — proceed/);
  assert.match(artifactStudio, /persistArtifactBundle/);
  assert.match(artifactStudio, /EmailArtifactCanvas/);
  assert.match(artifactStudio, /EmailArtifactEditorPanel/);
  assert.match(artifactStudio, /React Email editor/);
  assert.match(artifactStudio, /ChatArtifactMinimap/);
  assert.match(builderArtifactEditor, /ArtifactCanvasOverlay/);
});

test("operational build requirements use structured requirementSetup choices", async () => {
  const [route, builderPage, requirementSelector, promptMenu] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(builderPagePath, "utf8"),
    readFile(new URL("../../../dashboard/src/components/builder-requirement-selector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../dashboard/src/components/ai-elements/interactive-prompt-menu.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(route, /requirementSetup:\s*tool\(/);
  assert.match(route, /call requirementSetup and stop/);
  assert.match(route, /allowOther true so the user can type custom guidance/);
  assert.match(builderPage, /BuilderRequirementSelector/);
  assert.match(builderPage, /findActiveRequirementSetup/);
  assert.match(requirementSelector, /InteractivePromptMenu/);
  assert.match(promptMenu, /Tell Tallei what to do differently/);
});

test("event choices come from discovered connector triggers and scheduled fallback is hourly or daily", async () => {
  const [route, dispatcher, scheduleSelector, verification, triggerWebhook, connectorRoute] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(dispatcherPath, "utf8"),
    readFile(scheduleSelectorPath, "utf8"),
    readFile(verificationPath, "utf8"),
    readFile(triggerWebhookPath, "utf8"),
    readFile(connectorRoutePath, "utf8"),
  ]);

  assert.match(dispatcher, /listComposioTriggerTypes/);
  assert.match(route, /scheduleSetup:\s*tool\(/);
  assert.match(route, /Schedule playbook for trigger_schedule/);
  assert.match(route, /Tell Tallei what to do differently/);
  assert.match(route, /Never invent event-driven execution unless an exact discovered trigger capability/);
  assert.match(scheduleSelector, /Every hour/);
  assert.match(scheduleSelector, /Weekly on Monday/);
  assert.match(scheduleSelector, /InteractivePromptMenu/);
  assert.doesNotMatch(scheduleSelector, /every 1 minute|every 5 minutes/i);
  assert.doesNotMatch(scheduleSelector, /Real-time triggers are not available/);
  assert.doesNotMatch(scheduleSelector, /Validation error/);
  assert.match(verification, /DELETE FROM workflow_connector_triggers/);
  assert.match(verification, /trigger_instance_id = \$1 AND workflow_id <> \$2/);
  assert.match(verification, /selectedTrigger\?\.mode === "event" \? null/);
  assert.match(triggerWebhook, /createSpecLoopRun/);
  assert.match(triggerWebhook, /startLoopRunWorkflow/);
  assert.match(triggerWebhook, /workflow_connector_trigger_events/);
  assert.match(connectorRoute, /handleComposioTriggerWebhook/);
  assert.ok(connectorRoute.indexOf('router.post("/composio/webhook"') < connectorRoute.indexOf("router.use(authMiddleware)"));
});

test("spec save approves and persists in one saveLoop step", async () => {
  const [route, dispatcher] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(dispatcherPath, "utf8"),
  ]);

  assert.doesNotMatch(route, /approveSpec:\s*tool\(/);
  assert.doesNotMatch(route, /draftSpec:\s*tool\(/);
  assert.match(route, /saveLoop with preview true/);
  assert.match(route, /I'm happy with this/);
  assert.match(route, /Activate.*I'll do more changes/);
  assert.match(dispatcher, /input\.preview === true/);
  assert.match(dispatcher, /ensureDraftedSpec/);
  assert.match(dispatcher, /runWorkflowVerification/);
  assert.match(dispatcher, /spec\.status !== "approved"/);
  assert.match(dispatcher, /approveLoopSpec\(/);
  assert.match(dispatcher, /\["intent_resolved", "spec_drafted", "spec_approved", "saved", "failed"\]/);
  assert.match(dispatcher, /\["saved", "failed"\]/);
  assert.match(dispatcher, /isRecoverableBuilderError/);
});

test("spec refinement and approval preserve the resolved build contract", async () => {
  const specs = await readFile(specsPath, "utf8");

  assert.match(specs, /current\.specJson\.buildContract \? \{ schedule: current\.specJson\.schedule \}/);
  assert.match(specs, /buildContract: current\.specJson\.buildContract/);
  assert.match(specs, /spec\.specJson\.buildContract \? \{ buildContract: spec\.specJson\.buildContract \}/);
});
