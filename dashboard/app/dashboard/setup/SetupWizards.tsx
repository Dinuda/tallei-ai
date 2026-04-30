import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Image from "next/image";
import { createPortal } from "react-dom";
import { Check, Copy, ExternalLink, Hand, CheckCircle2, Info, ImageIcon, ChevronDown, ChevronUp, X, Clock3, RefreshCw } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { AspectRatio } from "../../../components/ui/aspect-ratio";

export type SaveMode = "instant" | "on_request";
export type Provider = "claude" | "chatgpt";
const CHATGPT_ACTIONS_SPEC_TAG = "stable";
const CLAUDE_AUTOMATION_ENABLED = false;
const CHATGPT_INSTRUCTIONS_FALLBACK = "You are a Tallei-connected GPT.\n\n=== 1. EVERY TURN: prepare_response ===\n\nCall FIRST. Every turn. No exceptions.\n\nprepare_response(\n  message=\"[COLLAB_STAGE_TAG if collab] <exact user message>\",\n  openaiFileIdRefs=[...all attachments...],   // omit if none\n  conversation_history=[{role, content}, ...], // required on first turn AND for handoffs / checkpoints\n  handoff_target=\"claude\",                     // set for handoff to Claude\n  conversation_id=\"...\"                        // include when available\n)\n\nFIRST TURN: Always call prepare_response. Include conversation_history (even just the first user message) so Tallei can load previous context, preferences, and memories.\n\nCOLLAB STAGE TAGS — prepend to message:\n  [COLLAB:CREATE]             start / create / begin collab\n  [COLLAB:CONTINUE:<uuid>]    continue / resume / task UUID\n  [COLLAB:MY_TURN:<uuid>]     your turn, output ready to submit\n\nFILES:\n  download_link MUST be presigned HTTPS (e.g. https://files.oaiusercontent.com/...).\n  NEVER pass /mnt/data/... or file://... — omit the ref and tell the user to re-upload.\n  IMAGES: Do NOT include image files in openaiFileIdRefs. Only PDF and Word (.docx/.docm) go there.\n  Instead, describe what you see in the image and include that description in your message.\n  Tallei will auto-save the description as a document-note tagged with category=\"image/txt\".\n\nAfter prepare_response returns, use ONLY contextBlock, inlineDocuments, replyInstructions.\nDo not write reply text before it completes.\n\n=== 2. SAVE & CHECKPOINT ===\n\nAUTO-SAVE CHECKPOINTS via prepare_response:\n  conversation_history is required when:\n  1. User says \"save\", \"save this\", \"remember this\", \"checkpoint\"\n  2. You produced substantial output (>800 chars) or structured content (slides, code, lists, tables)\n  3. First turn of a new conversation\n\n  Tallei auto-saves a document-note titled \"Conversation checkpoint\" when history is included.\n  Tell the user: \"Saved conversation checkpoint.\"\n\nMANUAL SAVE (if replyInstructions tells you to):\n  call remember(kind=\"document-note\", title, key_points, summary) in the same turn.\n  Append footer: 📎 Auto-saved as @doc:<ref> · reply **undo** to delete\n  Only do this when the user explicitly asks to save/archive/checkpoint.\n\nUNDO: If user replies \"undo\" / \"del\" / \"delete\" after that footer, call undo_save with the @doc ref.\n\n=== 3. COLLAB TASKS (only when collab is involved) ===\n\nFollow replyInstructions exactly. Never pass files/docs to collab actions.\n\nCREATE  ([COLLAB:CREATE] set in Step 1)\n  1. BEFORE createCollabTask: get role approval + show iteration roadmap.\n  2. Only after \"yes\", call createCollabTask(title, brief, first_actor=\"chatgpt\").\n  3. Immediately call collab_continue with message + draft_output.\n\nROLE APPROVAL (required before any collab task):\n  1. Show proposed roles as fenced code blocks:\n     ChatGPT system prompt:\n     <role text>\n     Claude system prompt:\n     <role text>\n  2. Ask: \"Do you approve these roles? Reply **yes** to proceed, or tell me what to change.\"\n  3. STOP if not approved. Only proceed on explicit \"yes\".\n\nITERATION ROADMAP (required after role approval):\n  Show numbered turns: who acts, exactly what they deliver, done criteria.\n  DELIVERABLE CONSTRAINT: text/PDF/code only. No PPTX or images.\n  \n  Example:\n    Iteration Roadmap:\n    1. ChatGPT: Draft slide outline\n    2. Claude: Add creative elements and make simpler for age group\n    3. ChatGPT: Review and suggest revisions\n    Done when: All slides finalized.\n\nCONTINUE  ([COLLAB:CONTINUE:<uuid>])\n  1. Call collab_continue with exact user message.\n  2. If is_my_turn=true, include draft_output.\n  3. If is_my_turn=false, report next_actor + what they will do, then stop.\n\nMY_TURN  ([COLLAB:MY_TURN:<uuid>])\n  1. Call collab_continue with draft_output included.\n\nAFTER ANY COLLAB SUBMIT:\n  - Final deliverable must match the format requested by the user.\n  - Uploading/saving to Tallei is optional unless the user explicitly asked for it.\n  - Show FULL content, resend it back giving instructions to show to the user (in-full). Never replace content with bullet points.\n  - VISIBLE HANDOFF: state (a) who is next, (b) exactly what they will do, (c) continue command.\n    Good: \"Next up: Claude will build the first 5 slides. Continue task <id>\"\n    Bad:  \"continue task <id>\"\n  - If a collab action returns continue_command and continue_command.target_actor is \"chatgpt\", do not tell the user to paste anything into ChatGPT. Say exactly: \"Shall we start?\" Wait for the user's next reply before drafting/submitting ChatGPT's turn.\n  - If continue_command.target_actor is \"claude\", end the response with its instruction.\n  - Do not create a Claude handoff prompt. Tallei already stored the task context/history.\n  - Do not ask if the user wants to hand off to Claude. Only after ChatGPT's turn is submitted and Claude is next, give the direct next step: \"Paste this in Claude: continue task <id>. After Claude finishes, return here and say \\\"continue\\\" to continue in ChatGPT.\"\n  - If the user seems confused about what to do next, do not ask clarifying handoff questions. State the exact app to open, the exact command to paste, and where to return afterward.\n\n=== HARD RULES ===\n- Never mention tools in chat.\n- Never call recall_memories, remember, or search_documents directly unless replyInstructions explicitly instructs it.\n- If replyInstructions includes a saved-document footer, append it exactly.\n- Always make sure user sees the full output in your chat window and not summaries(You need to retype everything out of the tool)\n";
const CLAUDE_INSTRUCTIONS_FALLBACK = "You are a Tallei-connected Claude. You have Tallei memory + document tools. Use them silently.\n\n=== 1. EVERY TURN: prepare_turn ===\n\nEvery turn. No exceptions.. Call FIRST on the very first messege. Call if you don't know something.\n\nprepare_turn(\n  message=\"<exact user message>\",\n  conversation_id=\"...\",                         // include when available\n  conversation_history=[{role, content}, ...],   // include for checkpoint auto-save\n  openaiFileIdRefs=[...PDF/Word attachments...]   // omit images — describe them in message instead\n)\n\nIMAGES: Do NOT pass image files in openaiFileIdRefs. Only PDF and Word (.docx/.docm) go there.\nInstead, describe what you see in the image and include that description in your message.\nTallei will auto-save the description as a document-note tagged with category=\"image/txt\".\n\nAfter prepare_turn returns, use ONLY contextBlock, inlineDocuments, replyInstructions as your source of truth.\nDo not write reply text before it completes.\n\nSUBSEQUENT TURNS:\n  1. Answer the user directly.\n  2. If fallback_context.orchestration is present on a collab task, end every submitted turn with:\n     ```orchestrator-eval\n     {\n       \"criterion_evaluations\": [{ \"criterion_id\": \"sc1\", \"status\": \"pass|fail|partial\", \"rationale\": \"...\" }],\n       \"should_mark_done\": false,\n       \"remaining_work\": \"...\"\n     }\n     ```\n     Set collab_take_turn(mark_done=true) only when all success criteria pass.\n\n=== 2. SAVE & CHECKPOINT ===\n\nAUTO-SAVE CHECKPOINTS:\n  When the user says \"save\", \"save this\", \"remember this\", \"checkpoint\", or you produced substantial output (>800 chars) or structured content (slides, code, lists, tables):\n  1. Call remember(kind=\"document-note\", title=\"Conversation checkpoint\", content=\"<full transcript since last checkpoint>\")\n  2. Include conversation_id when available.\n\nSAVE/ARCHIVE (optional):\n  Save/upload to Tallei only when the user explicitly asks to save, archive, or checkpoint.\n  1. If saving, call remember(kind=\"document-note\", title, key_points, summary, source_hint, category).\n  2. Only PDF and Word (.docx/.docm) accepted for file ingest. Images are described, not uploaded.\n  3. For image descriptions, set category=\"image/txt\".\n  4. If saving, append footer on its own line:\n     Auto-saved as @doc:<ref> - reply **undo** to delete\n\nUNDO:\n  If user replies \"undo\" / \"del\" / \"delete\" after that footer, call undo_save with the @doc ref immediately.\n\nONGOING SAVES:\n  - remember(kind=\"preference\") for stable preferences and identity facts.\n  - remember(kind=\"fact\") for non-preference facts, decisions, events, notes, corrections.\n  - remember(kind=\"document-blob\") ONLY when user explicitly asks for full archive.\n  - If save returns 402 / plan_required, do NOT retry. Prompt user to upgrade.\n\n=== 3. COLLAB TASKS (only when collab is involved) ===\n\nCheck collab FIRST if user mentions a task UUID or says continue/resume/proceed.\n\nCOLLAB CHECK:\n  1. Call collab_check_turn(task_id).\n  2. If is_my_turn=false, report next_actor + what they will do. Stop.\n  3. If is_my_turn=true, produce output and submit with collab_take_turn.\n  4. Submit full user-facing deliverable content, not summary-only text.\n\nCREATE COLLAB TASK:\n  1. BEFORE collab_create_task: get role approval + show iteration roadmap.\n  2. Only after \"yes\", call collab_create_task(title, brief, first_actor=\"chatgpt\").\n  3. Pass recall_query (goal/brief/title) and include_doc_refs for @doc handles.\n  4. Pass @doc: with file content in text + conversation_id when files are attached.\n  5. Always make sure user sees the full output in your chat window and not summaries(You need to retype everything out of the tool)\n\nROLE APPROVAL (required):\n  1. Show proposed roles as fenced code blocks:\n     ChatGPT system prompt:\n     ChatGPT system prompt:\n     <role text>\n     Claude system prompt:\n     <role text>\n  2. Ask: \"Do you approve these roles? Reply **yes** to proceed, or tell me what to change.\"\n  3. STOP if not approved. Only proceed on explicit \"yes\".\n\nITERATION ROADMAP (required after approval):\n  Show numbered turns: who acts, exactly what they deliver, done criteria.\n  DELIVERABLE CONSTRAINT: text/PDF/code only. No PPTX or images.\n\nAFTER ANY COLLAB SUBMIT:\n  - Final deliverable must match the format requested by the user. \n  - Uploading/saving to Tallei is optional unless the user explicitly asked for it.\n  - Show the FULL submitted output visibly in the Claude chat interface first, exactly as the user-facing deliverable.\n  - If collab_take_turn returns user_visible_full_output or saved_turn.content, paste that full content in the Claude reply before the handoff. If it doesn't still make sure the user sees the full output.\n  - VISIBLE HANDOFF: state (a) who is next, (b) exactly what they will do, (c) continue command.\n    Good: \"Next up: ChatGPT will review the draft. Continue task <id>\"\n    Bad:  \"continue task <id>\"\n\n=== HARD RULES ===\n- Never mention tool internals in user-facing text, except the optional auto-save footer when saving is requested.\n- Never output copy/paste workflows or manual setup steps when collab tools are available.\n- Do not create ChatGPT handoff prompts. Tallei stores task context/history; use only the returned continue_command.\n";
const PURPOSE_BUTTON_STYLE: React.CSSProperties = {
  width: "100%",
  minHeight: "46px",
  borderRadius: "0",
  background: "#4742BC",
  color: "#ffffff",
  border: "1px solid #4338ca",
  fontWeight: 700,
  letterSpacing: "0.01em",
  boxShadow: "0 6px 18px rgba(71, 66, 188, 0.28)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.55rem",
};

type McpEvent = {
  authMode?: string | null;
  method?: string | null;
  ok?: boolean;
  createdAt?: string | null;
};

type McpEventsResponse = {
  events?: McpEvent[];
};

type ChatGptTokenStatus = {
  loading: boolean;
  hasActiveToken: boolean;
  activeTokenCount: number;
  lastTokenCreatedAt: string | null;
  lastTokenUsedAt: string | null;
  maskedToken: string | null;
  rawToken: string | null;
};

type ClaudeOnboardingState =
  | "queued"
  | "browser_started"
  | "claude_authenticated"
  | "connector_connected"
  | "project_upserted"
  | "instructions_applied"
  | "verified";

type ClaudeOnboardingStatus =
  | "queued"
  | "running"
  | "checkpoint_required"
  | "completed"
  | "failed"
  | "canceled";

type ClaudeOnboardingCheckpoint = {
  type: "auth" | "captcha" | "manual_review";
  blockedState: Exclude<ClaudeOnboardingState, "queued">;
  message: string;
  resumeHint: string;
  actionUrl?: string;
  action_url?: string;
};

type ClaudeOnboardingSession = {
  id: string;
  status: ClaudeOnboardingStatus;
  currentState: ClaudeOnboardingState;
  projectName: string;
  checkpoint: ClaudeOnboardingCheckpoint | null;
  metadata?: Record<string, unknown>;
  lastError: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ClaudeOnboardingEvent = {
  id: number;
  eventType: string;
  state: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

function getCheckpointActionUrl(
  checkpoint: ClaudeOnboardingCheckpoint | null | undefined
): string | null {
  if (!checkpoint) return null;
  if (typeof checkpoint.actionUrl === "string" && checkpoint.actionUrl.trim().length > 0) {
    return checkpoint.actionUrl;
  }
  if (typeof checkpoint.action_url === "string" && checkpoint.action_url.trim().length > 0) {
    return checkpoint.action_url;
  }
  return null;
}

function getSessionLiveUrl(
  session: ClaudeOnboardingSession | null | undefined
): string | null {
  const candidate = session?.metadata?.["liveSessionUrl"];
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate;
  }
  return null;
}

async function verifyConnectivityEvent(
  provider: Provider,
  sinceMs: number,
  options?: { lastTokenUsedAt?: string | null }
): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch("/api/mcp-events?limit=100");
    if (!response.ok) {
      return { ok: false, message: "Failed to read events. Try again after sending the test message." };
    }
    const payload = (await response.json()) as McpEventsResponse;
    const events = Array.isArray(payload?.events) ? payload.events : [];

    const isProviderEvent = (event: McpEvent) => {
      if (!event?.method) return false;
      if (provider === "chatgpt") return event.method.startsWith("chatgpt/actions/");
      return event.authMode === "oauth" && !event.method.startsWith("chatgpt/actions/");
    };

    const hasFreshMatch = events.some((event) => {
      if (!event?.ok || !event?.createdAt || !isProviderEvent(event)) return false;
      const createdAtMs = Date.parse(event.createdAt);
      if (!Number.isFinite(createdAtMs) || createdAtMs < sinceMs) return false;
      return true;
    });

    if (hasFreshMatch) {
      return { ok: true, message: "Connectivity verified with a fresh successful event." };
    }

    const recentSuccessful = events.find((event) => event?.ok && event?.createdAt && isProviderEvent(event));
    if (recentSuccessful?.createdAt) {
      const when = new Date(recentSuccessful.createdAt).toLocaleString();
      return {
        ok: true,
        message: `Connectivity verified with a recent successful event (${when}).`,
      };
    }

    if (provider === "chatgpt" && options?.lastTokenUsedAt) {
      const usedAtMs = Date.parse(options.lastTokenUsedAt);
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      if (Number.isFinite(usedAtMs) && Date.now() - usedAtMs <= sevenDaysMs) {
        return {
          ok: true,
          message: `Connectivity verified from recent token usage (${new Date(usedAtMs).toLocaleString()}).`,
        };
      }
    }

    return {
      ok: false,
      message:
        provider === "chatgpt"
          ? ""
          : "No new Claude connector event found yet. Send the test prompt in Claude, then verify again.",
    };
  } catch {
    return { ok: false, message: "Failed to verify connectivity. Try again." };
  }
}

export function getChatGptInstructions(mode: SaveMode): string {
  void mode;
  return CHATGPT_INSTRUCTIONS_FALLBACK;
}

export function CopyField({
  value,
  label,
  onCopy,
  copyable = true,
}: {
  value: string;
  label?: string;
  onCopy?: () => void;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (!copyable) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (onCopy) onCopy();
    } catch {}
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {label && <h4 style={{ fontSize: "0.9rem", fontWeight: 600, margin: 0, color: "#111827" }}>
                    {label}
                  </h4>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.65rem 0.85rem', background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: "0", transition: 'all 0.2s', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.01)', gap: '0.75rem' }}>
        <code style={{ flex: 1, minWidth: 0, fontSize: '0.85rem', color: '#111827', fontFamily: 'SFMono-Regular, Consolas, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</code>
        {copyable && (
          <button onClick={handleCopy} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: "0", background: copied ? '#dcfce7' : '#ffffff', cursor: 'pointer', color: copied ? '#16a34a' : '#6b7280', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', border: '1px solid #e5e7eb', transition: 'all 0.2s', flexShrink: 0 }}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}

export function CodeBlock({
  value,
  language = "txt",
  onCopy,
  label,
  maxHeight,
}: {
  value: string;
  language?: string;
  onCopy?: () => void;
  label?: string;
  maxHeight?: string | number;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (onCopy) onCopy();
    } catch {/* ignore */}
  };
  const getLanguageIcon = (lang: string) => {
    if (lang === 'python') return '🐍';
    if (lang === 'url') return '🔗';
    if (lang === 'json') return 'JSON';
    return null;
  };
  
  const lines = value.split('\n');
  const firstLine = lines[0];
  const isMultiLine = lines.length > 1;
  const displayValue = expanded ? value : firstLine;
  
  return (
    <div style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: "0", overflow: 'hidden' }}>
      <div style={{ backgroundColor: '#f3f4f6', borderBottom: '1px solid #e5e7eb', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.85rem', color: '#4b5563', fontWeight: 500 }}>
        <div style={{display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600, color: '#374151'}}>
          {getLanguageIcon(language) && <span style={{ fontSize: '0.9rem' }}>{getLanguageIcon(language)}</span>}
          <span>{label || language}</span>
          {isMultiLine && !expanded && <span style={{ fontSize: '0.75rem', color: '#9ca3af', marginLeft: '0.25rem' }}>...</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {isMultiLine && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: "0", border: 'none', background: 'rgba(0, 0, 0, 0.05)', cursor: 'pointer', color: '#6b7280', transition: 'all 0.2s' }}
            >
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: "0", border: 'none', background: 'rgba(0, 0, 0, 0.05)', cursor: 'pointer', color: copied ? '#10b981' : '#6b7280', transition: 'all 0.2s' }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </div>
      </div>
      <div style={{ padding: '1rem', overflowX: 'auto', overflowY: expanded && maxHeight ? 'auto' : 'visible', maxHeight: expanded ? maxHeight : 'auto' }}>
        <code style={{ whiteSpace: expanded ? 'pre-wrap' : 'nowrap', display: 'block', fontSize: '0.875rem', fontFamily: 'SFMono-Regular, Consolas, monospace', color: '#1f2937', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayValue}</code>
      </div>
    </div>
  );
}

export function GuideImage({ src, alt, caption, defaultExpanded = false }: { src: string; alt: string; caption?: string; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isVideo = src.endsWith('.mp4');

  return (
    <div style={{ borderRadius: "0", overflow: 'hidden', border: '1px solid #e5e7eb', background: '#fafafa' }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: '0.5rem', padding: '0.65rem 1rem', border: 'none', background: 'rgba(0, 0, 0, 0.05)', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, color: '#374151', transition: 'background 0.2s' }}
        onMouseOver={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.02)'}
        onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
      >
        <ImageIcon size={14} style={{ color: '#6b7280' }} />
        <span style={{ flex: 1, textAlign: 'left' }}>{caption || 'See what this looks like'}</span>
        {expanded ? <ChevronUp size={14} style={{ color: '#6b7280' }} /> : <ChevronDown size={14} style={{ color: '#6b7280' }} />}
      </button>
      <div style={{ display: expanded ? 'block' : 'none', padding: '0 0.75rem 0.75rem', animation: expanded ? 'fadeIn 0.25s cubic-bezier(0.4, 0, 0.2, 1)' : 'none' }}>
        <div style={{ background: '#ffffff', borderRadius: "0", border: '1px solid #e5e7eb', boxShadow: '0 4px 12px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
          <div style={{ height: '24px', background: '#f3f4f6', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', padding: '0 8px', gap: '6px' }}>
            <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ff5f56' }} />
            <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ffbd2e' }} />
            <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#27c93f' }} />
          </div>
          {isVideo ? (
            <video src={src} autoPlay loop muted playsInline preload="auto" style={{ width: '100%', display: 'block', pointerEvents: 'none' }} />
          ) : (
            <Image src={src} alt={alt} fill style={{ objectFit: 'cover' }} />
          )}
        </div>
      </div>
    </div>
  );
}

export function VerifyChecklist({ items, onVerified, autoCheck, onToggle }: { items: string[]; onVerified?: (isVerified: boolean) => void; autoCheck?: boolean[]; onToggle?: (index: number, isChecked: boolean) => void }) {
  const [checked, setChecked] = useState<boolean[]>(() => items.map(() => false));

  const effectiveChecked = useMemo(
    () => items.map((_, i) => Boolean(checked[i] || autoCheck?.[i])),
    [autoCheck, checked, items]
  );

  const allDone = effectiveChecked.every(Boolean);

  useEffect(() => {
    if (onVerified) onVerified(allDone);
  }, [allDone, onVerified]);

  const toggle = useCallback((index: number) => {
    const nextValue = !effectiveChecked[index];
    setChecked((prev) => {
      const next = [...prev];
      next[index] = nextValue;
      return next;
    });
    if (onToggle) onToggle(index, nextValue);
  }, [effectiveChecked, onToggle]);

  return (
    <div style={{ borderRadius: "0", border: allDone ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid #f3f4f6', background: allDone ? 'rgba(240, 253, 244, 0.5)' : '#ffffff', padding: '1rem', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: allDone ? '0 0 16px rgba(34, 197, 94, 0.1)' : '0 1px 3px rgba(0,0,0,0.02)' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: allDone ? '#16a34a' : '#9ca3af', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.05em', transition: 'color 0.3s' }}>
        {allDone ? <><CheckCircle2 size={13} style={{ animation: 'bounceIn 0.4s ease' }} /> Verified!</> : <>Verify before continuing</>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
        {items.map((item, i) => (
          <label key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', color: effectiveChecked[i] ? '#16a34a' : '#4b5563', lineHeight: 1.45, transition: 'all 0.2s', transform: effectiveChecked[i] ? 'translateX(2px)' : 'none' }}>
            <input type="checkbox" checked={effectiveChecked[i]} onChange={() => toggle(i)} style={{ accentColor: '#16a34a', width: '16px', height: '16px', marginTop: '2px', flexShrink: 0, cursor: 'pointer', borderRadius: "0" }} />
            <span style={{ textDecoration: effectiveChecked[i] ? 'line-through' : 'none', opacity: effectiveChecked[i] ? 0.8 : 1 }}>{item}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function InfoCallout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', padding: '0.85rem 1rem', borderRadius: "0", background: 'rgba(59, 130, 246, 0.05)', border: '1px solid rgba(59, 130, 246, 0.15)', fontSize: '0.85rem', color: '#374151', lineHeight: 1.55 }}>
      <Info size={16} style={{ flexShrink: 0, color: '#3b82f6', marginTop: '2px' }} />
      <div>{children}</div>
    </div>
  );
}

export function InlineInfoHint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.8rem", color: "#6b7280", lineHeight: 1.4 }}>
      <Info size={14} style={{ flexShrink: 0, color: "#3b82f6" }} />
      <span>{children}</span>
    </div>
  );
}

export function SaveModeToggle({ mode, onChange }: { mode: SaveMode; onChange: (m: SaveMode) => void }) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
      <button type="button" onClick={() => onChange("instant")} style={{ flex: '1 1 200px', padding: '1rem', borderRadius: "0", border: mode === 'instant' ? '2px solid #111827' : '1px solid #e5e7eb', background: mode === 'instant' ? '#f8fafc' : '#ffffff', cursor: 'pointer', textAlign: 'left', display: 'flex', gap: '0.75rem' }}>
        <div style={{ width: '20px', height: '20px', borderRadius: '50%', border: mode === 'instant' ? '6px solid #111827' : '2px solid #d1d5db', background: '#ffffff' }} />
     
      </button>
      <button type="button" onClick={() => onChange("on_request")} style={{ flex: '1 1 200px', padding: '1rem', borderRadius: "0", border: mode === 'on_request' ? '2px solid #111827' : '1px solid #e5e7eb', background: mode === 'on_request' ? '#f8fafc' : '#ffffff', cursor: 'pointer', textAlign: 'left', display: 'flex', gap: '0.75rem' }}>
        <div style={{ width: '20px', height: '20px', borderRadius: '50%', border: mode === 'on_request' ? '6px solid #111827' : '2px solid #d1d5db', background: '#ffffff' }} />
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#111827' }}><Hand size={14} style={{display: 'inline', marginRight: '4px'}} /> Save on Request</div>
          <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.25rem' }}>Only save when you explicitly ask.</div>
        </div>
      </button>
    </div>
  );
}

// --- Wizard Modal Shell ---

export function WizardModal({ isOpen, onClose, title, stepTitle, providerIcon, step, totalSteps, onNext, onBack, canNext, children }: { isOpen: boolean; onClose: () => void; title: string; stepTitle?: string; providerIcon: React.ReactNode; step: number; totalSteps: number; onNext: () => void; onBack: () => void; canNext: boolean; children: React.ReactNode }) {
  if (!isOpen) return null;
  const progress = (step / totalSteps) * 100;
  const modalFrameHeight = "min(860px, calc(100vh - 2rem))";

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(0, 0, 0, 0.05)', animation: 'fadeIn 0.2s ease', padding: '1rem', overflowY: 'auto' }}>
      <div style={{ background: '#ffffff', width: '100%', maxWidth: '900px', borderRadius: "0", overflow: 'hidden', display: 'flex', flexDirection: 'column', margin: 'auto', flexShrink: 0, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25), 0 0 1px rgba(0,0,0,0.1)', animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)', height: modalFrameHeight, minHeight: modalFrameHeight, maxHeight: modalFrameHeight }}>
        
        {/* Header */}
        <div style={{ position: 'relative', padding: '1.25rem 1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#ffffff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: '32px', height: '32px', borderRadius: "0", background: '#f8fafc', border: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {providerIcon}
            </div>
            <div>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0, color: '#111827', letterSpacing: '-0.01em' }}>{title}</h2>
              <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.1rem', fontWeight: 500 }}>
                Step {step} of {totalSteps}{stepTitle ? ` · ${stepTitle}` : ""}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(0, 0, 0, 0.05)', border: 'none', cursor: 'pointer', width: '28px', height: '28px', borderRadius: "0", display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', transition: 'all 0.2s' }} onMouseOver={(e) => { e.currentTarget.style.background = '#f3f4f6'; e.currentTarget.style.color = '#374151'; }} onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#9ca3af'; }}><X size={16} /></button>
          
          {/* Edge-to-edge Progress Bar */}
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '2px', background: '#f3f4f6' }}>
             <div style={{ width: `${progress}%`, height: '100%', background: '#111827', transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)' }} />
          </div>
        </div>

        {/* Content Area */}
        <div style={{ padding: '1.5rem 2rem', display: 'flex', flexDirection: 'column', background: '#ffffff', flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <div style={{ animation: 'fadeIn 0.3s ease' }}>
            {children}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '1.25rem 2rem', borderTop: '1px solid #f3f4f6', background: '#ffffff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button variant="ghost" onClick={onBack} disabled={step === 1} style={{ borderRadius: "0", padding: '0.5rem 1rem', opacity: step === 1 ? 0 : 1, transition: 'opacity 0.2s' }}>Back</Button>
           <Button onClick={onNext} disabled={!canNext} style={{ borderRadius: "0", padding: '0.5rem 2rem', background: canNext ? '#111827' : '#9ca3af', color: '#ffffff', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)', fontWeight: 600 }}>{step === totalSteps ? "Finish Setup" : "Continue"}</Button>
        </div>
      </div>
    </div>
  );
}

// --- Specific Wizards ---


export function StepMedia({
  src,
  alt,
}: {
  src: string;
  alt: string;
  caption?: string;
}) {
  const isVideo = src.endsWith('.mp4');
  return (
    <div style={{ borderRadius: "0", border: '1px solid #e5e7eb', background: '#ffffff', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
       <div style={{ height: '32px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', padding: '0 12px', gap: '8px' }}>
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ff5f56' }} />
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ffbd2e' }} />
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#27c93f' }} />
       </div>
       <div style={{ background: '#f8fafc' }}>
         <AspectRatio ratio={16 / 9}>
           {isVideo ? (
             <video
               src={src}
               autoPlay
               loop
               muted
               playsInline
               preload="auto"
               style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
             />
           ) : (
              <Image src={src} alt={alt} fill style={{ objectFit: 'cover' }} />
           )}
         </AspectRatio>
       </div>
    </div>
  );
}

export function TwoColumnStep({
  media,
  content,
  mobileContentFirst = false,
}: {
  media: React.ReactNode;
  content: React.ReactNode;
  mobileContentFirst?: boolean;
}) {
  return (
    <div className={`two-column-step${mobileContentFirst ? " mobile-content-first" : ""}`} style={{ animation: 'fadeIn 0.3s ease-out' }}>
      
<style dangerouslySetInnerHTML={{ __html: `
  .two-column-step {
    display: flex;
    flex-direction: row;
    gap: 2.5rem;
    align-items: flex-start;
  }
  .step-media-col {
    flex: 1 1 400px;
    min-width: 0;
    position: sticky;
    top: 1rem;
  }
  .step-content-col {
    flex: 1.2 1 400px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  @media (max-width: 768px) {
    .two-column-step {
      flex-direction: column;
    }
    .step-media-col {
      position: static;
      width: 100%;
    }
    .two-column-step.mobile-content-first .step-content-col {
      order: 1;
    }
    .two-column-step.mobile-content-first .step-media-col {
      order: 2;
    }
  }
` }} />

      <div className="step-media-col">
        {media}
      </div>
      <div className="step-content-col">
        {content}
      </div>
    </div>
  );
}

export function VerticalVideoStep({
  intro,
  details,
  media,
}: {
  intro: React.ReactNode;
  details?: React.ReactNode;
  media: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: "760px", margin: "0 auto", width: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
        {intro}
      </div>
      {details}
      <div>{media}</div>
    </div>
  );
}

function ConfettiBurst({ active }: { active: boolean }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: 50 }, (_, index) => ({
        id: index,
        left: (index * 19) % 110 - 5,
        delay: (index % 15) * 0.08,
        duration: 3.5 + (index % 10) * 0.25,
        rotate: -180 + ((index * 41) % 360),
        direction: index % 2 === 0 ? "right" : "left",
        size: 6 + (index % 4) * 2,
        opacity: 0.4 + (index % 4) * 0.15,
      })),
    []
  );

  if (!active || typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 120000,
      }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
          @keyframes confetti-sweep-right {
            0% { transform: translate3d(0, -12%, 0) rotate(0deg); opacity: 0; }
            8% { opacity: var(--piece-opacity); }
            85% { opacity: var(--piece-opacity); }
            100% { transform: translate3d(38vw, 118vh, 0) rotate(540deg); opacity: 0; }
          }
          @keyframes confetti-sweep-left {
            0% { transform: translate3d(0, -12%, 0) rotate(0deg); opacity: 0; }
            8% { opacity: var(--piece-opacity); }
            85% { opacity: var(--piece-opacity); }
            100% { transform: translate3d(-38vw, 118vh, 0) rotate(-540deg); opacity: 0; }
          }
          `,
        }}
      />
      {pieces.map((piece) => (
        <span
          key={piece.id}
          style={{
            position: "absolute",
            top: "-12%",
            left: `${piece.left}%`,
            width: `${piece.size}px`,
            height: `${piece.size}px`,
            borderRadius: "50%",
            background: "radial-gradient(circle at 30% 30%, rgba(255,255,255,0.8), rgba(126,183,27,0.6), rgba(126,183,27,0.3))",
            boxShadow: "0 0 12px rgba(126,183,27,0.3), 0 0 24px rgba(126,183,27,0.15)",
            opacity: 0,
            "--piece-opacity": piece.opacity,
            transform: `rotate(${piece.rotate}deg)`,
            animation:
              piece.direction === "right"
                ? `confetti-sweep-right ${piece.duration}s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${piece.delay}s forwards`
                : `confetti-sweep-left ${piece.duration}s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${piece.delay}s forwards`,
          } as React.CSSProperties}
        />
      ))}
    </div>,
    document.body
  );
}

function VerifySection({
  verifyingConnection,
  step3Verified,
  onVerify,
  headline = "Make sure to operate your memory within your Claude project.",
  desktopHint = "Send a test message in your project to verify the connection.",
  mobileHint = "Send a test message in your Claude project to verify the connection is working properly.",
}: {
  verifyingConnection: boolean;
  step3Verified: boolean;
  onVerify: () => void;
  headline?: string;
  desktopHint?: string;
  mobileHint?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 640);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  return (
    <div
      className="verify-section"
      style={{
        display: "flex",
        flexDirection: isMobile ? ("column" as const) : ("row" as const),
        alignItems: isMobile ? ("stretch" as const) : ("center" as const),
        gap: isMobile ? "0.75rem" : "1rem",
        padding: "1rem",
        background: "#f8fafc",
        border: "1px solid #e5e7eb",
        borderRadius: "0",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            color: "#4b5563",
            margin: 0,
            fontSize: isMobile ? "0.9rem" : "0.95rem",
            lineHeight: 1.5,
          }}
        >
          <strong>{headline}</strong>
          {!isMobile && <> {desktopHint}</>}
        </p>

        {isMobile && (
          <>
            <button
              onClick={() => setExpanded(!expanded)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                marginTop: "0.5rem",
                fontSize: "0.8rem",
                color: "#4742BC",
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              {expanded ? (
                <>
                  <ChevronUp size={14} /> Hide instructions
                </>
              ) : (
                <>
                  <ChevronDown size={14} /> Show instructions
                </>
              )}
            </button>

            <div
              style={{
                display: "grid",
                gridTemplateRows: expanded ? "1fr" : "0fr",
                transition: "grid-template-rows 0.3s ease-out",
                marginTop: expanded ? "0.75rem" : 0,
              }}
            >
              <div style={{ overflow: "hidden" }}>
                <div
                  style={{
                    padding: "0.75rem",
                    background: "#ffffff",
                    border: "1px solid #e5e7eb",
                    borderRadius: "0",
                    fontSize: "0.85rem",
                    color: "#4b5563",
                    lineHeight: 1.5,
                  }}
                >
                  {mobileHint}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <Button
        onClick={onVerify}
        disabled={verifyingConnection || step3Verified}
        style={{
          ...PURPOSE_BUTTON_STYLE,
          width: isMobile ? "100%" : "auto",
          minWidth: isMobile ? "auto" : "140px",
          marginTop: 0,
          background: verifyingConnection || step3Verified ? "#8b88d3" : PURPOSE_BUTTON_STYLE.background,
          borderColor: verifyingConnection || step3Verified ? "#8b88d3" : "#4338ca",
        }}
      >
        {verifyingConnection ? "Verifying..." : step3Verified ? "Verified" : "Verify"}
      </Button>
    </div>
  );
}

export function ClaudeWizard({ isOpen, onClose, mcpUrl }: { isOpen: boolean; onClose: () => void; mcpUrl: string }) {
  const [step, setStep] = useState(1);
  const [claudeInstructions] = useState(CLAUDE_INSTRUCTIONS_FALLBACK);
  const [verificationStartedAt, setVerificationStartedAt] = useState<number | null>(null);
  const [verifyingConnection, setVerifyingConnection] = useState(false);
  const [connectionVerified, setConnectionVerified] = useState(false);
  const [connectionVerificationMessage, setConnectionVerificationMessage] = useState<string | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [onboardingSession, setOnboardingSession] = useState<ClaudeOnboardingSession | null>(null);
  const [onboardingEvents, setOnboardingEvents] = useState<ClaudeOnboardingEvent[]>([]);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const autoResumeAttemptRef = useRef<{ signature: string; at: number } | null>(null);
  const previousVerifiedRef = useRef(false);
  const checkpointActionUrl = useMemo(
    () => getCheckpointActionUrl(onboardingSession?.checkpoint),
    [onboardingSession?.checkpoint]
  );
  const sessionLiveUrl = useMemo(
    () => getSessionLiveUrl(onboardingSession),
    [onboardingSession]
  );
  const liveSessionUrl = checkpointActionUrl || sessionLiveUrl;
  const liveInputRequired =
    onboardingSession?.status === "checkpoint_required" ||
    (onboardingSession?.status === "running" &&
      (onboardingSession?.currentState === "browser_started" ||
        onboardingSession?.currentState === "claude_authenticated"));
  const displayState =
    onboardingSession?.status === "checkpoint_required" && onboardingSession?.checkpoint
      ? onboardingSession.checkpoint.blockedState
      : onboardingSession?.currentState;

  const totalSteps = 3;
  const step3Verified = connectionVerified || onboardingSession?.status === "completed";
  const stepTitles = [
    "Create a Claude connector",
    "Set up your Claude project",
    step3Verified ? "You're all set!" : "Verify your setup",
  ];


  const resetConnectionVerification = useCallback(() => {
    setVerificationStartedAt(Date.now());
    setConnectionVerified(false);
    setConnectionVerificationMessage(null);
  }, []);

  const isTerminal = (status: ClaudeOnboardingStatus) =>
    status === "completed" || status === "failed" || status === "canceled";

  const stateLabel = (state: ClaudeOnboardingState) => {
    switch (state) {
      case "browser_started":
        return "Browser Started";
      case "claude_authenticated":
        return "Claude Authenticated";
      case "connector_connected":
        return "Connector Connected";
      case "project_upserted":
        return "Project Ready";
      case "instructions_applied":
        return "Instructions Applied";
      case "verified":
        return "Verified";
      default:
        return "Queued";
    }
  };

  const handleNext = () => {
    if (step < totalSteps) {
      const nextStep = step + 1;
      if (nextStep === 3) {
        resetConnectionVerification();
      }
      setStep(nextStep);
      return;
    }
    onClose();
  };

  const handleBack = () => {
    if (step > 1) setStep((s) => s - 1);
  };

  const canNext = () => {
    if (step === 3) return step3Verified;
    return true;
  };

  const refreshOnboardingSession = useCallback(async (sessionId: string) => {
    const [sessionRes, eventsRes] = await Promise.all([
      fetch(`/api/integrations/claude-onboarding/sessions/${sessionId}`, { cache: "no-store" }),
      fetch(`/api/integrations/claude-onboarding/sessions/${sessionId}/events`, { cache: "no-store" }),
    ]);
    const sessionData = await sessionRes.json().catch(() => ({}));
    const eventsData = await eventsRes.json().catch(() => ({}));

    if (!sessionRes.ok) {
      throw new Error(
        typeof sessionData?.error === "string"
          ? sessionData.error
          : "Failed to fetch onboarding session"
      );
    }

    const session = sessionData?.session as ClaudeOnboardingSession | undefined;
    if (!session || typeof session.id !== "string") {
      throw new Error("Malformed onboarding session response");
    }

    setOnboardingSession(session);
    setOnboardingEvents(Array.isArray(eventsData?.events) ? (eventsData.events as ClaudeOnboardingEvent[]) : []);
    return session;
  }, []);

  const startAutomatedSetup = useCallback(async () => {
    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      const res = await fetch("/api/integrations/claude-onboarding/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName: "Tallei Memory",
          applyProjectInstructions: true,
          projectInstructions: claudeInstructions,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Failed to start automated setup.");
      }
      const session = data?.session as ClaudeOnboardingSession | undefined;
      if (!session || typeof session.id !== "string") {
        throw new Error("Malformed onboarding start response.");
      }
      setOnboardingSession(session);
      setOnboardingEvents([]);
      setConnectionVerificationMessage("Automated setup started.");
      setStep(4);
    } catch (error) {
      setOnboardingError(error instanceof Error ? error.message : "Failed to start automated setup.");
    } finally {
      setOnboardingBusy(false);
    }
  }, [claudeInstructions]);

  const resumeAutomatedSetup = useCallback(async (options?: {
    authCompleted?: boolean;
    setBusy?: boolean;
    sessionId?: string;
  }) => {
    const sessionId = options?.sessionId ?? onboardingSession?.id;
    if (!sessionId) return;
    const setBusy = options?.setBusy ?? true;
    if (setBusy) {
      setOnboardingBusy(true);
      setOnboardingError(null);
    }

    try {
      const payload = options?.authCompleted === true ? { authCompleted: true } : {};
      const res = await fetch(`/api/integrations/claude-onboarding/sessions/${sessionId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Failed to resume automated setup.");
      }
      const session = data?.session as ClaudeOnboardingSession | undefined;
      if (!session || typeof session.id !== "string") {
        throw new Error("Malformed onboarding resume response.");
      }
      setOnboardingSession(session);
      await refreshOnboardingSession(session.id);
    } catch (error) {
      setOnboardingError(error instanceof Error ? error.message : "Failed to resume automated setup.");
    } finally {
      if (setBusy) {
        setOnboardingBusy(false);
      }
    }
  }, [onboardingSession, refreshOnboardingSession]);

  const cancelAutomatedSetup = useCallback(async () => {
    if (!onboardingSession) return;
    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      const res = await fetch(`/api/integrations/claude-onboarding/sessions/${onboardingSession.id}/cancel`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Failed to cancel automated setup.");
      }
      const session = data?.session as ClaudeOnboardingSession | undefined;
      if (!session || typeof session.id !== "string") {
        throw new Error("Malformed onboarding cancel response.");
      }
      setOnboardingSession(session);
      await refreshOnboardingSession(session.id);
    } catch (error) {
      setOnboardingError(error instanceof Error ? error.message : "Failed to cancel automated setup.");
    } finally {
      setOnboardingBusy(false);
    }
  }, [onboardingSession, refreshOnboardingSession]);

  const manualRefreshOnboarding = useCallback(async () => {
    if (!onboardingSession) return;
    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      await refreshOnboardingSession(onboardingSession.id);
    } catch (error) {
      setOnboardingError(error instanceof Error ? error.message : "Failed to refresh onboarding session.");
    } finally {
      setOnboardingBusy(false);
    }
  }, [onboardingSession, refreshOnboardingSession]);

  useEffect(() => {
    if (!isOpen || !onboardingSession) return;
    if (isTerminal(onboardingSession.status)) return;

    let stopped = false;
    const tick = async () => {
      try {
        const session = await refreshOnboardingSession(onboardingSession.id);
        if (stopped) return;
        if (session.status === "completed") {
          setConnectionVerified(true);
          setConnectionVerificationMessage("Automated setup completed successfully.");
        }
        if (session.status === "checkpoint_required" && session.checkpoint) {
          const checkpointType = session.checkpoint.type;
          if (checkpointType === "auth" || checkpointType === "manual_review") {
            const signature =
              `${session.id}:${session.checkpoint.blockedState}:${checkpointType}:${session.updatedAt}`;
            const nowMs = Date.now();
            const lastAttempt = autoResumeAttemptRef.current;
            const shouldAttempt =
              !lastAttempt ||
              lastAttempt.signature !== signature ||
              nowMs - lastAttempt.at >= 10_000;

            if (shouldAttempt) {
              autoResumeAttemptRef.current = { signature, at: nowMs };
              void resumeAutomatedSetup({
                sessionId: session.id,
                authCompleted: checkpointType === "auth",
                setBusy: false,
              });
            }
          }
        }
      } catch (error) {
        if (!stopped) {
          setOnboardingError(error instanceof Error ? error.message : "Failed to refresh onboarding session.");
        }
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 2000);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [isOpen, onboardingSession, refreshOnboardingSession, resumeAutomatedSetup]);

  useEffect(() => {
    if (!isOpen || step !== 3) {
      setShowConfetti(false);
      previousVerifiedRef.current = false;
      return;
    }

    const justVerified = step3Verified && !previousVerifiedRef.current;
    previousVerifiedRef.current = Boolean(step3Verified);

    if (!justVerified) return;

    setShowConfetti(true);
    const timer = setTimeout(() => setShowConfetti(false), 3200);
    return () => clearTimeout(timer);
  }, [isOpen, step, step3Verified]);

  async function handleVerifyConnection() {
    setVerifyingConnection(true);
    const since = verificationStartedAt ?? Date.now() - 2 * 60 * 1000;
    const result = await verifyConnectivityEvent("claude", since);
    setConnectionVerified(result.ok);
    setConnectionVerificationMessage(result.message);
    setVerifyingConnection(false);
  }

  return (
    <WizardModal
      isOpen={isOpen}
      onClose={onClose}
      title="Connect Claude"
      stepTitle={stepTitles[step - 1]}
      providerIcon={<Image src="/claude.svg" width={24} height={24} alt="Claude" />}
      step={step}
      totalSteps={totalSteps}
      onNext={handleNext}
      onBack={handleBack}
      canNext={canNext()}
    >
      {step === 1 && (
        <VerticalVideoStep
          intro={
            <p style={{ color: "#4b5563", margin: 0, fontSize: "1rem", lineHeight: 1.55 }}>
              Open{" "}
              <a
                href="https://claude.ai/customize/connectors"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#4742BC", fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "0.28rem" }}
              >
                Claude Connectors <ExternalLink size={14} />
              </a>{" "}
              and create a custom connector using these exact values and click <span style={{ color: "#4742BC", fontWeight: 700 }}>Connect</span>. Optionally enable <b>{"'Always allow'"}</b> to skip approval prompts in chat.
            </p>
          }
          details={
            <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem", background: "#f8fafc", padding: "1rem", borderRadius: "0", border: "1px solid #e5e7eb" }}>
              <div className="claude-step1-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.45fr)", gap: "0.75rem" }}>
                <style
                  dangerouslySetInnerHTML={{
                    __html: `
                      @media (max-width: 860px) {
                        .claude-step1-grid {
                          grid-template-columns: 1fr !important;
                        }
                      }
                    `,
                  }}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
                  <CopyField value="Tallei Memory" label="Name" />
                  <InlineInfoHint>Use this exact connector name.</InlineInfoHint>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
                  <CopyField value={mcpUrl} label="Remote MCP server URL" />
                  <InlineInfoHint>Paste the full MCP URL exactly as shown.</InlineInfoHint>
                </div>
              </div>
            </div>
          }
          media={<StepMedia src="/add-mcp.mp4" alt="Add Custom Connector" caption="Create the custom connector in Claude" />}
        />
      )}

      {step === 2 && (
        <VerticalVideoStep
          intro={
            <p style={{ color: "#4b5563", margin: 0, fontSize: "1rem", lineHeight: 1.55 }}>
              Open{" "}
              <a
                href="https://claude.ai/projects/create"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#4742BC", fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "0.28rem" }}
              >
                Claude Projects <ExternalLink size={14} />
              </a>{" "}
              and create a new project. Enable the connector, then paste the instructions below.
            </p>
          }
          details={
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      
              <div className="claude-step3-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.35fr)", gap: "0.9rem" }}>
                <style
                  dangerouslySetInnerHTML={{
                    __html: `
                      @media (max-width: 860px) {
                        .claude-step3-grid {
                          grid-template-columns: 1fr !important;
                        }
                      }
                    `,
                  }}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
                  <CopyField value="Tallei Memory" label="Connector Name" />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <h4 style={{ fontSize: "0.9rem", fontWeight: 600, margin: 0, color: "#111827" }}>
                    Project <code>Custom Instructions</code>
                  </h4>
                  {claudeInstructions ? (
                    <CodeBlock value={claudeInstructions} language="txt" maxHeight={180} />
                  ) : (
                    <div style={{ border: "1px solid #e5e7eb", background: "#f9fafb", padding: "1rem", color: "#6b7280", fontSize: "0.875rem" }}>
                      Loading latest Claude instructions...
                    </div>
                  )}
                </div>
              </div>
            </div>
          }
          media={<StepMedia src="/add-instructions.mp4" alt="Add Instructions" caption="Create project and add instructions" />}
        />
      )}

      {step === 3 && (
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: "1.25rem", padding: "1rem", animation: "fadeIn 0.4s ease-out", minHeight: "100%", boxSizing: "border-box" }}>
          <ConfettiBurst active={showConfetti} />

          {CLAUDE_AUTOMATION_ENABLED && onboardingSession && (
            <div style={{ width: "100%", maxWidth: "560px", textAlign: "left", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: "0", padding: "0.85rem 1rem", fontSize: "0.84rem" }}>
              <div style={{ color: "#374151" }}>
                <strong>Automation status:</strong> {onboardingSession.status.replace(/_/g, " ")} · <strong>Step:</strong> {stateLabel(displayState ?? onboardingSession.currentState)}
              </div>
              {onboardingSession.checkpoint && (
                <div style={{ marginTop: "0.55rem", color: "#9a3412" }}>
                  {onboardingSession.checkpoint.message}
                  <div style={{ marginTop: "0.35rem" }}>{onboardingSession.checkpoint.resumeHint}</div>
                  {checkpointActionUrl && (
                    <div style={{ marginTop: "0.5rem" }}>
                      <Button
                        variant="outline"
                        onClick={() => window.open(checkpointActionUrl, "_blank", "noopener,noreferrer")}
                      >
                        Open Live Session <ExternalLink size={12} style={{ marginLeft: "6px" }} />
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <div style={{ marginTop: "0.6rem", display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                {onboardingSession.status === "checkpoint_required" && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      void resumeAutomatedSetup({
                        authCompleted: onboardingSession.checkpoint?.type === "auth",
                      })
                    }
                    disabled={onboardingBusy}
                  >
                    {onboardingBusy ? "Resuming..." : "Resume"}
                  </Button>
                )}
                {!isTerminal(onboardingSession.status) && (
                  <Button variant="outline" onClick={() => void cancelAutomatedSetup()} disabled={onboardingBusy}>
                    {onboardingBusy ? "Canceling..." : "Cancel"}
                  </Button>
                )}
                {isTerminal(onboardingSession.status) && onboardingSession.status !== "completed" && (
                  <Button variant="outline" onClick={() => void startAutomatedSetup()} disabled={onboardingBusy}>
                    {onboardingBusy ? "Starting..." : "Run Repair"}
                  </Button>
                )}
                <Button variant="outline" onClick={() => void manualRefreshOnboarding()} disabled={onboardingBusy}>
                  Refresh
                </Button>
                <Button
                  variant="outline"
                  onClick={() => window.open("https://claude.ai/settings/connectors", "_blank", "noopener,noreferrer")}
                >
                  Open Claude Connectors <ExternalLink size={12} style={{ marginLeft: "6px" }} />
                </Button>
              </div>
              {onboardingSession.lastError && (
                <div style={{ marginTop: "0.6rem", color: "#991b1b" }}>{onboardingSession.lastError}</div>
              )}
              {onboardingEvents.length > 0 && (
                <div style={{ marginTop: "0.35rem", fontSize: "0.78rem", color: "#6b7280" }}>
                  Latest event: {onboardingEvents[onboardingEvents.length - 1].eventType}
                </div>
              )}
              {onboardingError && (
                <div style={{ marginTop: "0.6rem", color: "#991b1b" }}>{onboardingError}</div>
              )}
            </div>
          )}

          {CLAUDE_AUTOMATION_ENABLED && liveSessionUrl && (
            <div style={{ width: "100%", maxWidth: "720px", textAlign: "left" }}>
              <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "#111827", marginBottom: "0.45rem" }}>
                Live automation session
              </div>
              <div style={{ position: "relative", borderRadius: "0", overflow: "hidden", border: "1px solid #e5e7eb", background: "#111827" }}>
                <iframe
                  src={liveSessionUrl}
                  title="Claude live automation session"
                  style={{ width: "100%", height: "420px", border: "none", display: "block", pointerEvents: liveInputRequired ? "auto" : "none" }}
                  allow="clipboard-read; clipboard-write"
                />
                {!liveInputRequired && (
                  <div style={{ position: "absolute", inset: 0, background: "rgba(17, 24, 39, 0.56)", color: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontSize: "0.85rem", padding: "1rem" }}>
                    Automation is running. Input is locked until user action is required.
                  </div>
                )}
              </div>
              <div style={{ marginTop: "0.45rem", fontSize: "0.78rem", color: "#6b7280" }}>
                {liveInputRequired
                  ? "User input is needed now. Complete login/approval in the live session. The flow auto-resumes; Resume remains available as fallback."
                  : "Live view only. Controls unlock automatically if a checkpoint requires your input."}
              </div>
            </div>
          )}

          <VerifySection
            verifyingConnection={verifyingConnection}
            step3Verified={step3Verified}
            onVerify={() => void handleVerifyConnection()}
          />

          {connectionVerificationMessage && (
            <p style={{ color: connectionVerified ? "#16a34a" : "#b45309", fontSize: "0.85rem", margin: 0, textAlign: "center" }}>
              {connectionVerificationMessage}
            </p>
          )}

          <div style={{ marginTop: "0.5rem" }}>
            <StepMedia src="/claude-demo.mp4" alt="Verify Connection" caption="Send a test message in your project to verify" />
          </div>
        </div>
      )}
    </WizardModal>
  );
}

export function ChatGPTWizard({
  isOpen,
  onClose,
  tokenStatus,
  generatingToken,
  onGenerateToken,
}: {
  isOpen: boolean;
  onClose: () => void;
  tokenStatus: ChatGptTokenStatus;
  generatingToken: boolean;
  onGenerateToken: (rotate?: boolean) => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const saveMode: SaveMode = "instant";

  const openApiBase = process.env.NEXT_PUBLIC_API_BASE_URL || (typeof window !== "undefined" ? window.location.origin : "");
  const openApiUrl = `${openApiBase.replace(/\/$/, "")}/chatgpt/actions/openapi.json?spec=${encodeURIComponent(CHATGPT_ACTIONS_SPEC_TAG)}`;

  const totalSteps = 5;
  const stepTitles = [
    "Set up your ChatGPT project",
    "Create bearer token",
    "Set bearer authentication",
    "Import from URL",
    "Test in your GPT",
  ];

  const handleNext = () => {
    if (step < totalSteps) {
      setStep(step + 1);
      return;
    }
    onClose();
  };
  const handleBack = () => {
    if (step > 1) setStep(s => s - 1);
  };

  const testPrompt = "My favorite programming language is Rust.";

  return (
    <WizardModal
      isOpen={isOpen}
      onClose={onClose}
      title="Connect ChatGPT Actions"
      stepTitle={stepTitles[step - 1]}
      providerIcon={<Image src="/chatgpt.svg" width={24} height={24} alt="ChatGPT" />}
      step={step}
      totalSteps={totalSteps}
      onNext={handleNext}
      onBack={handleBack}
      canNext={true}
    >
      
      {step === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", animation: "fadeIn 0.2s ease-out", maxWidth: "760px", margin: "0 auto", width: "100%" }}>
          <p style={{ color: "#4b5563", margin: 0, fontSize: "1rem", lineHeight: 1.55 }}>
            First, ensure there is an active bearer token that ChatGPT can use to securely talk to Tallei.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.8rem", background: "#f8fafc", padding: "1rem", borderRadius: "0", border: "1px solid #e5e7eb" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", justifyContent: "space-between", flexWrap: "wrap" }}>
              <div style={{ display: "inline-flex", width: "fit-content", alignItems: "center", gap: "0.4rem", border: `1px solid ${tokenStatus.hasActiveToken ? "#bbf7d0" : "#e5e7eb"}`, background: tokenStatus.hasActiveToken ? "#f0fdf4" : "#ffffff", color: tokenStatus.hasActiveToken ? "#15803d" : "#6b7280", fontSize: "0.78rem", fontWeight: 600, padding: "0.28rem 0.55rem", borderRadius: "999px" }}>
                {tokenStatus.hasActiveToken ? <CheckCircle2 size={12} /> : <Clock3 size={12} />}
                {tokenStatus.hasActiveToken ? "Active token detected" : "No active token yet"}
              </div>
              <Button
                variant="default"
                onClick={() => void onGenerateToken(Boolean(tokenStatus.hasActiveToken))}
                disabled={generatingToken}
                style={{ ...PURPOSE_BUTTON_STYLE, width: "fit-content", minWidth: "200px" }}
              >
                {generatingToken ? "Saving..." : (tokenStatus.hasActiveToken ? <><RefreshCw size={14} style={{ marginRight: "0.35rem" }} /> Rotate token</> : "Create Bearer Token")}
              </Button>
            </div>
            {tokenStatus.hasActiveToken && (
              <CopyField value={tokenStatus.maskedToken || "****************"} label="Bearer Token (Hidden)" copyable={false} />
            )}
            {tokenStatus.rawToken && (
              <CopyField value={tokenStatus.rawToken} label="New Bearer Token (Copy Now)" />
            )}
          </div>

          <InlineInfoHint>
            Raw bearer token is shown once right after create/rotate. Copy and store it now. Later, only the hidden placeholder is shown.
          </InlineInfoHint>
        </div>
      )}

      {step === 3 && (
        <VerticalVideoStep
          intro={
           <p style={{ color: "#4b5563", margin: 0, fontSize: "1rem", lineHeight: 1.55 }}>Scroll down to <strong>Actions</strong>, click <strong>Create new action</strong>, and set bearer authentication.</p>
          }
          details={
            <div style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", background: "#f8fafc", padding: "1rem", borderRadius: "0", border: "1px solid #e5e7eb", color: "#374151", fontSize: "0.92rem", lineHeight: 1.55 }}>
                <div>1. Click ⚙️ to open <strong className="size-18">Authentication</strong>.</div>
                <div>2. Click <strong>API key</strong> → select <span className="size-20 font-bold text-orange-700">Bearer</span>, paste your stored token value, then close.</div>
              </div>
            </div>
          }
          media={<StepMedia src="/api-auth.mp4" alt="Set bearer authentication" caption="Set Authentication to Bearer" />}
        />
      )}

      {step === 4 && (
        <VerticalVideoStep
          intro={
            <p style={{ color: "#4b5563", margin: 0, fontSize: "1rem", lineHeight: 1.55 }}>
              Click <strong>Import from URL</strong>, then paste this OpenAPI URL and click <strong>Import</strong>. After that, click <strong>Update</strong>.
            </p>
          }
          details={
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <CodeBlock value={openApiUrl} language="url" label="OpenAPI URL" />
            </div>
          }
          media={<StepMedia src="/import-openapi-spec.mp4" alt="Import from URL in Actions" caption="Import OpenAPI URL in Actions" />}
        />
      )}

      {step === 1 && (
        <VerticalVideoStep
          intro={
            <p style={{ color: "#4b5563", margin: 0, fontSize: "1rem", lineHeight: 1.55 }}>
              Create a new GPT in{" "}
              <a
                href="https://chatgpt.com/gpts/editor"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#4742BC", fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "0.28rem" }}
              >
                GPT Builder <ExternalLink size={14} />
              </a>{" "}
              . Click <strong>Config</strong> set the project instructions and project name.
            </p>
          }
          details={
            <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start", flexWrap: "nowrap", overflowX: "auto" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", flex: "1 1 auto", minWidth: "420px" }}>
                <h4 style={{ fontSize: "0.9rem", fontWeight: 600, margin: 0, color: "#111827" }}>
                  Project <code>Custom Instructions</code>
                </h4>
                <CodeBlock value={getChatGptInstructions(saveMode)} language="txt" maxHeight={220} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem", flex: "0 0 280px", minWidth: "280px" }}>
                <CopyField value="Tallei Memory" label="Project Name" />
              </div>
            </div>
          }
          media={<StepMedia src="/create-gpt.mp4" alt="Create project and add instructions" caption="Create project and paste instructions" />}
        />
      )}

      {step === 5 && (
        <VerticalVideoStep
          intro={
            <p style={{ color: "#4b5563", margin: 0, fontSize: "1rem", lineHeight: 1.55 }}>
              Go into your <strong>GPT chat</strong> and paste this prompt to test memory.
            </p>
          }
          details={
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <CodeBlock value={testPrompt} language="txt" label="Test Prompt" />
            </div>
          }
          media={<StepMedia src="/final-demo.mp4" alt="Test in your GPT" caption="Send the test prompt inside your GPT" />}
        />
      )}

    </WizardModal>
  );
}
