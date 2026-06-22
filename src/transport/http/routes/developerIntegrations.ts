import { Router } from "express";
import { authMiddleware, requireScopes, type AuthRequest } from "../middleware/auth.middleware.js";
import { buildToolSpecRegistry, listLearnedToolSpecs, listLearnedUseCases } from "../../../services/tool-spec/index.js";
import { listAvailableLoopToolsForAuth } from "../../../services/loop-executor/tool-catalog.js";

const router = Router();
router.use(authMiddleware);

router.get("/integrations", requireScopes(["memory:read"]), async (req: AuthRequest, res) => {
  try {
    const [registry, toolCatalog, learnedToolSpecs, learnedUseCases] = await Promise.all([
      buildToolSpecRegistry(req.authContext!),
      listAvailableLoopToolsForAuth(req.authContext!),
      listLearnedToolSpecs(),
      listLearnedUseCases(req.authContext!),
    ]);

    res.json({
      toolSpecRegistry: {
        internalTools: registry.internalTools,
        composioToolkits: registry.composioToolkits,
        toolContracts: registry.toolContracts,
        useCases: registry.useCases,
        generatedAt: registry.generatedAt,
      },
      toolCatalog,
      learnedCatalog: {
        toolSpecs: learnedToolSpecs,
        useCases: learnedUseCases,
      },
      platform: {
        renderTargets: [
          { target: "canvas.email", description: "Editable email workspace — operator can visually edit the email before approval or sending." },
          { target: "canvas.preview", description: "Read-only rendered email preview — useful when visual review is helpful but editing is not needed." },
        ],
        inputSurfaces: [
          { surface: "input.text", description: "Single-line operator text input." },
          { surface: "input.markdown", description: "Multi-line markdown or notes paste (e.g. sprint notes)." },
          { surface: "input.contacts_csv", description: "Recipient list upload or paste." },
          { surface: "input.audience_id", description: "Configured audience or list ID." },
          { surface: "review.sources", description: "Web search source approval with custom URL add." },
          { surface: "review.memories", description: "Memory item selection for downstream agents." },
          { surface: "review.draft", description: "Markdown draft review before continuing." },
          { surface: "review.email", description: "Canvas email draft review (uses renderTarget)." },
          { surface: "review.preview", description: "Read-only rendered final preview (uses canvas.preview)." },
          { surface: "confirm.send", description: "Final pre-send confirmation." },
        ],
        approvalFlows: {
          gateTypes: [
            { type: "input", description: "Operator provides required data through nested input.surface metadata." },
            { type: "approval", description: "Operator approves canvas review or connector action through nested approval metadata." },
          ],
          approvalModes: [
            { mode: "before", description: "Approval is required before the action executes." },
            { mode: "after", description: "Action executes first, then approval is requested." },
            { mode: "manual_gate", description: "Approval is collected via a manual gate interaction." },
          ],
          rejectionBehaviors: [
            { behavior: "block", description: "Block the workflow if rejected." },
            { behavior: "revise", description: "Allow the operator to revise and resubmit." },
            { behavior: "skip_stage", description: "Skip the current stage and continue." },
          ],
          channels: [
            { channel: "primary", description: "In-app notification (default)." },
            { channel: "email", description: "Email notification." },
            { channel: "gmail", description: "Gmail-based notification." },
            { channel: "telegram", description: "Telegram notification." },
            { channel: "whatsapp", description: "WhatsApp notification." },
          ],
          executionModes: [
            { mode: "short_circuit", description: "Tool executes and returns raw output directly without LLM synthesis." },
            { mode: "llm_assisted", description: "LLM synthesizes output using tool results as context." },
            { mode: "approval_executed", description: "Tool requires human approval before execution." },
          ],
          toolEffects: [
            { effect: "none", description: "No external side-effects (purely internal)." },
            { effect: "read_external", description: "Reads external data without modifying it." },
            { effect: "write_external", description: "Writes or modifies external data." },
            { effect: "irreversible_external", description: "Irreversible external action (e.g. delete)." },
          ],
          stageKinds: [
            { kind: "agent", description: "Run one agent with a tool." },
            { kind: "approval_gate", description: "Pause for human approval on an artifact." },
            { kind: "input_gate", description: "Pause for structured operator input." },
            { kind: "external_action", description: "Execute a catalog external-action tool (e.g. broadcast)." },
          ],
          connectorActionRisks: [
            { risk: "read", description: "Read-only connector action." },
            { risk: "write", description: "Writes or modifies external data via connector." },
            { risk: "send", description: "Sends data externally (e.g. email send)." },
            { risk: "destructive", description: "Irreversible destructive connector action." },
          ],
        },
      },
    });
  } catch (error) {
    console.error("Error fetching developer integrations:", error);
    res.status(500).json({ error: "Failed to fetch developer integrations" });
  }
});

export default router;
