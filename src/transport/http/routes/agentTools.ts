import express, { type Request, type Response } from "express";

import { verifyAgentEngineToken } from "../../../infrastructure/auth/agent-engine-token.js";
import type { AuthContext } from "../../../domain/auth/index.js";
import { executePrepareResponseAction, executeRecallAction, executeRememberAction, executeUploadBlobAction } from "../../shared/chat-actions.js";
import {
  attachUploadedFilesToTaskContext,
  buildTurnFallbackContext,
  claimTurn,
  createTask,
  getTask,
  submitTurn,
  type CollabModelActor,
} from "../../../services/collab.js";

const router = express.Router();

type AgentToolName =
  | "recall_memories"
  | "save_memory"
  | "prepare_response"
  | "collab_create_task"
  | "collab_check_turn"
  | "collab_take_turn"
  | "ingest_uploaded_file"
  | "get_task";

const SUPPORTED_TOOLS = new Set<AgentToolName>([
  "recall_memories",
  "save_memory",
  "prepare_response",
  "collab_create_task",
  "collab_check_turn",
  "collab_take_turn",
  "ingest_uploaded_file",
  "get_task",
]);

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${key} is required`), { status: 400 });
  }
  return value.trim();
}

function readActor(value: unknown, fallback: CollabModelActor): CollabModelActor {
  return value === "claude" || value === "chatgpt" ? value : fallback;
}

function authenticate(req: Request): AuthContext {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw Object.assign(new Error("Missing Agent Engine bearer token"), { status: 401 });
  }
  return verifyAgentEngineToken(header.slice(7).trim());
}

async function dispatchTool(toolName: AgentToolName, auth: AuthContext, input: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case "recall_memories": {
      const result = await executeRecallAction(auth, {
        query: requireString(input, "query"),
        limit: typeof input["limit"] === "number" ? input["limit"] : 5,
        types: Array.isArray(input["types"]) ? input["types"] as never[] : undefined,
        include_doc_refs: Array.isArray(input["include_doc_refs"]) ? input["include_doc_refs"] as string[] : undefined,
        openaiFileIdRefs: Array.isArray(input["openaiFileIdRefs"]) ? input["openaiFileIdRefs"] as never[] : undefined,
        conversation_id: typeof input["conversation_id"] === "string" ? input["conversation_id"] : null,
      });
      return result.body;
    }
    case "save_memory": {
      const result = await executeRememberAction(auth, {
        kind: requireString(input, "kind") as never,
        content: typeof input["content"] === "string" ? input["content"] : undefined,
        title: typeof input["title"] === "string" ? input["title"] : undefined,
        key_points: Array.isArray(input["key_points"]) ? input["key_points"] as string[] : undefined,
        summary: typeof input["summary"] === "string" ? input["summary"] : undefined,
        source_hint: typeof input["source_hint"] === "string" ? input["source_hint"] : undefined,
        category: typeof input["category"] === "string" ? input["category"] : undefined,
        preference_key: typeof input["preference_key"] === "string" ? input["preference_key"] : undefined,
        platform: typeof input["platform"] === "string" ? input["platform"] as never : "gemini",
        openaiFileIdRefs: Array.isArray(input["openaiFileIdRefs"]) ? input["openaiFileIdRefs"] as never[] : undefined,
        conversation_id: typeof input["conversation_id"] === "string" ? input["conversation_id"] : null,
      });
      return result.body;
    }
    case "prepare_response": {
      const result = await executePrepareResponseAction(auth, {
        message: requireString(input, "message"),
        last_recall: readRecord(input["last_recall"]) as never,
        openaiFileIdRefs: Array.isArray(input["openaiFileIdRefs"]) ? input["openaiFileIdRefs"] as never[] : undefined,
        conversation_id: typeof input["conversation_id"] === "string" ? input["conversation_id"] : null,
      });
      return result.body;
    }
    case "collab_create_task": {
      const task = await createTask({
        title: requireString(input, "title"),
        brief: typeof input["brief"] === "string" ? input["brief"] : null,
        firstActor: readActor(input["first_actor"], "chatgpt"),
        maxIterations: typeof input["max_iterations"] === "number" ? input["max_iterations"] : undefined,
        context: readRecord(input["context"]),
      }, auth);
      return { task };
    }
    case "collab_check_turn": {
      const taskId = requireString(input, "task_id");
      const actor = readActor(input["actor"], "chatgpt");
      const task = await claimTurn(taskId, actor, auth);
      return {
        is_my_turn: Boolean(task),
        task,
        fallback_context: task ? buildTurnFallbackContext(task, actor) : null,
      };
    }
    case "collab_take_turn": {
      const task = await submitTurn(
        requireString(input, "task_id"),
        readActor(input["actor"], "chatgpt"),
        requireString(input, "content"),
        auth,
        { markDone: input["mark_done"] === true }
      );
      return { task };
    }
    case "ingest_uploaded_file": {
      const taskId = typeof input["task_id"] === "string" ? input["task_id"] : null;
      if (taskId) {
        return attachUploadedFilesToTaskContext(taskId, auth, {
          openaiFileIdRefs: Array.isArray(input["openaiFileIdRefs"]) ? input["openaiFileIdRefs"] as never[] : undefined,
          documentRefs: Array.isArray(input["documentRefs"]) ? input["documentRefs"] as string[] : undefined,
          conversationId: typeof input["conversation_id"] === "string" ? input["conversation_id"] : null,
          title: typeof input["title"] === "string" ? input["title"] : undefined,
        });
      }
      const result = await executeUploadBlobAction(auth, {
        openaiFileIdRefs: Array.isArray(input["openaiFileIdRefs"]) ? input["openaiFileIdRefs"] as never[] : [],
        conversation_id: typeof input["conversation_id"] === "string" ? input["conversation_id"] : null,
        title: typeof input["title"] === "string" ? input["title"] : undefined,
      });
      return result.body;
    }
    case "get_task": {
      const task = await getTask(requireString(input, "task_id"), auth);
      return { task };
    }
  }
}

router.post("/:toolName", async (req: Request, res: Response) => {
  const toolName = req.params.toolName as AgentToolName;
  if (!SUPPORTED_TOOLS.has(toolName)) {
    res.status(404).json({ error: "Unsupported Agent Engine tool" });
    return;
  }

  try {
    const auth = authenticate(req);
    const input = readRecord(readRecord(req.body)["input"] ?? req.body);
    const result = await dispatchTool(toolName, auth, input);
    res.json({ ok: true, tool: toolName, result });
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 500;
    res.status(status).json({
      ok: false,
      error: error instanceof Error ? error.message : "Agent tool call failed",
    });
  }
});

export default router;
