import OpenAI from "openai";

import { config } from "../config/index.js";

export type PlannerMode = "interview" | "finalize";

export interface WebSearchResult {
  query: string;
  url: string;
  snippet: string;
}

export interface PlannerTurn {
  role: "planner" | "user" | "system";
  content: string;
  ts?: string;
  web_searches?: WebSearchResult[];
}

export interface OrchestrationPlan {
  title: string;
  summary: string;
  phases: Array<{ id: string; name: string; outputs: string[] }>;
  success_criteria: Array<{ id: string; text: string; weight: number }>;
  constraints: string[];
  risks: string[];
  stack_decisions: Array<{ decision: string; rationale: string }>;
  open_questions: string[];
  first_actor: "chatgpt" | "claude";
  max_iterations: number;
  web_research: Array<{ url: string; summary: string }>;
}

export interface ProviderRoleSuggestion {
  chatgpt_role: string;
  claude_role: string;
  first_actor_recommendation: "chatgpt" | "claude";
}

export type PlannerStepResult =
  | { kind: "question"; question: string; rationale: string; web_searches: WebSearchResult[] }
  | { kind: "plan"; plan: OrchestrationPlan; web_searches: WebSearchResult[] };

const PLANNER_SYSTEM_PROMPT =
  "You are Tallei's pre-flight orchestrator. Interview the user one question at a time. " +
  "Use a grill-me style: surface decision branches, resolve critical dependencies first, and define done clearly. " +
  "Each question must include a recommended default answer. Keep questions concise. " +
  "Do not ask for information that can be inferred from the provided context. " +
  "Use web search when relevant facts are uncertain or time-sensitive. " +
  "Only return JSON that matches the provided schema.";

const interviewJsonSchema = {
  name: "planner_interview_step",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "question", "rationale", "web_searches", "plan"],
    properties: {
      kind: { type: "string", enum: ["question", "plan"] },
      question: {
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
      },
      rationale: {
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
      },
      web_searches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["query", "url", "snippet"],
          properties: {
            query: { type: "string" },
            url: { type: "string" },
            snippet: { type: "string" },
          },
        },
      },
      // Planner may occasionally produce a complete plan during interview.
      plan: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: [
              "title",
              "summary",
              "phases",
              "success_criteria",
              "constraints",
              "risks",
              "stack_decisions",
              "open_questions",
              "first_actor",
              "max_iterations",
              "web_research",
            ],
            properties: {
              title: { type: "string", minLength: 1 },
              summary: { type: "string", minLength: 1 },
              phases: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "name", "outputs"],
                  properties: {
                    id: { type: "string", minLength: 1 },
                    name: { type: "string", minLength: 1 },
                    outputs: { type: "array", items: { type: "string" } },
                  },
                },
              },
              success_criteria: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "text", "weight"],
                  properties: {
                    id: { type: "string", minLength: 1 },
                    text: { type: "string", minLength: 1 },
                    weight: { type: "integer", minimum: 1, maximum: 3 },
                  },
                },
              },
              constraints: { type: "array", items: { type: "string" } },
              risks: { type: "array", items: { type: "string" } },
              stack_decisions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["decision", "rationale"],
                  properties: {
                    decision: { type: "string" },
                    rationale: { type: "string" },
                  },
                },
              },
              open_questions: { type: "array", items: { type: "string" } },
              first_actor: { type: "string", enum: ["chatgpt", "claude"] },
              max_iterations: { type: "integer", minimum: 1, maximum: 8 },
              web_research: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["url", "summary"],
                  properties: {
                    url: { type: "string" },
                    summary: { type: "string" },
                  },
                },
              },
            },
          },
          { type: "null" },
        ],
      },
    },
  },
} as const;

const finalizeJsonSchema = {
  name: "planner_finalize_step",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "plan", "web_searches"],
    properties: {
      kind: { type: "string", enum: ["plan"] },
      plan: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "summary",
          "phases",
          "success_criteria",
          "constraints",
          "risks",
          "stack_decisions",
          "open_questions",
          "first_actor",
          "max_iterations",
          "web_research",
        ],
        properties: {
          title: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          phases: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "name", "outputs"],
              properties: {
                id: { type: "string", minLength: 1 },
                name: { type: "string", minLength: 1 },
                outputs: { type: "array", items: { type: "string" } },
              },
            },
          },
          success_criteria: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "text", "weight"],
              properties: {
                id: { type: "string", minLength: 1 },
                text: { type: "string", minLength: 1 },
                weight: { type: "integer", minimum: 1, maximum: 3 },
              },
            },
          },
          constraints: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          stack_decisions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["decision", "rationale"],
              properties: {
                decision: { type: "string" },
                rationale: { type: "string" },
              },
            },
          },
          open_questions: { type: "array", items: { type: "string" } },
          first_actor: { type: "string", enum: ["chatgpt", "claude"] },
          max_iterations: { type: "integer", minimum: 1, maximum: 8 },
          web_research: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["url", "summary"],
              properties: {
                url: { type: "string" },
                summary: { type: "string" },
              },
            },
          },
        },
      },
      web_searches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["query", "url", "snippet"],
          properties: {
            query: { type: "string" },
            url: { type: "string" },
            snippet: { type: "string" },
          },
        },
      },
    },
  },
} as const;

const providerRoleJsonSchema = {
  name: "planner_provider_roles",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["chatgpt_role", "claude_role", "first_actor_recommendation"],
    properties: {
      chatgpt_role: { type: "string", minLength: 1 },
      claude_role: { type: "string", minLength: 1 },
      first_actor_recommendation: { type: "string", enum: ["chatgpt", "claude"] },
    },
  },
} as const;

let plannerClient: OpenAI | null = null;

function getPlannerClient(): OpenAI {
  if (plannerClient) return plannerClient;
  if (!config.openaiApiKey) {
    throw new Error("TALLEI_LLM__OPENAI_API_KEY is required for orchestration planner");
  }
  plannerClient = new OpenAI({ apiKey: config.openaiApiKey });
  return plannerClient;
}

function normalizeWebSearches(value: unknown): WebSearchResult[] {
  if (!Array.isArray(value)) return [];
  const results: WebSearchResult[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const query = typeof row["query"] === "string" ? row["query"].trim() : "";
    const url = typeof row["url"] === "string" ? row["url"].trim() : "";
    const snippet = typeof row["snippet"] === "string" ? row["snippet"].trim() : "";
    if (!query && !url && !snippet) continue;
    results.push({ query, url, snippet });
  }
  return results.slice(0, 20);
}

function normalizePlan(value: unknown): OrchestrationPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Planner response missing plan object");
  }
  const row = value as Record<string, unknown>;
  const title = typeof row["title"] === "string" ? row["title"].trim() : "";
  const summary = typeof row["summary"] === "string" ? row["summary"].trim() : "";
  if (!title || !summary) {
    throw new Error("Planner returned invalid plan shape");
  }

  const phases = Array.isArray(row["phases"])
    ? row["phases"]
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        .map((item) => ({
          id: typeof item["id"] === "string" ? item["id"] : "",
          name: typeof item["name"] === "string" ? item["name"] : "",
          outputs: Array.isArray(item["outputs"]) ? item["outputs"].filter((v): v is string => typeof v === "string") : [],
        }))
        .filter((phase) => phase.id && phase.name)
    : [];

  const successCriteria = Array.isArray(row["success_criteria"])
    ? row["success_criteria"]
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        .map((item) => ({
          id: typeof item["id"] === "string" ? item["id"] : "",
          text: typeof item["text"] === "string" ? item["text"] : "",
          weight:
            typeof item["weight"] === "number"
              ? Math.min(3, Math.max(1, Math.trunc(item["weight"])))
              : 1,
        }))
        .filter((criterion) => criterion.id && criterion.text)
    : [];

  if (phases.length === 0 || successCriteria.length === 0) {
    throw new Error("Planner returned incomplete plan");
  }

  const constraints = Array.isArray(row["constraints"]) ? row["constraints"].filter((v): v is string => typeof v === "string") : [];
  const risks = Array.isArray(row["risks"]) ? row["risks"].filter((v): v is string => typeof v === "string") : [];
  const stackDecisions = Array.isArray(row["stack_decisions"])
    ? row["stack_decisions"]
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        .map((item) => ({
          decision: typeof item["decision"] === "string" ? item["decision"] : "",
          rationale: typeof item["rationale"] === "string" ? item["rationale"] : "",
        }))
        .filter((item) => item.decision && item.rationale)
    : [];
  const openQuestions = Array.isArray(row["open_questions"])
    ? row["open_questions"].filter((v): v is string => typeof v === "string")
    : [];
  const firstActor = row["first_actor"] === "claude" ? "claude" : "chatgpt";
  const maxIterationsRaw = typeof row["max_iterations"] === "number" ? row["max_iterations"] : 4;
  const maxIterations = Math.min(8, Math.max(1, Math.trunc(maxIterationsRaw)));
  const webResearch = Array.isArray(row["web_research"])
    ? row["web_research"]
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        .map((item) => ({
          url: typeof item["url"] === "string" ? item["url"] : "",
          summary: typeof item["summary"] === "string" ? item["summary"] : "",
        }))
        .filter((item) => item.url && item.summary)
    : [];

  return {
    title,
    summary,
    phases,
    success_criteria: successCriteria,
    constraints,
    risks,
    stack_decisions: stackDecisions,
    open_questions: openQuestions,
    first_actor: firstActor,
    max_iterations: maxIterations,
    web_research: webResearch,
  };
}

function extractResponseText(response: any): string {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const output = Array.isArray(response?.output) ? response.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

async function callPlanner(params: {
  mode: PlannerMode;
  goal: string;
  transcript: PlannerTurn[];
  webSearchBudget: number;
}): Promise<any> {
  const timeoutMs = Math.max(5_000, config.plannerRequestTimeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const schema = params.mode === "interview" ? interviewJsonSchema : finalizeJsonSchema;
  const modeInstruction =
    params.mode === "interview"
      ? "Ask exactly one next question unless the plan is fully ready."
      : "Finalize and return the completed plan now.";

  const input: Array<Record<string, unknown>> = [
    {
      role: "system",
      content:
        `${PLANNER_SYSTEM_PROMPT}\n${modeInstruction}\n` +
        `Goal: ${params.goal}\n` +
        `Web search budget remaining: ${Math.max(0, params.webSearchBudget)}. ` +
        "If budget is 0, do not rely on web_search_preview.",
    },
    ...params.transcript.map((turn) => ({
      role: turn.role === "user" ? "user" : turn.role === "planner" ? "assistant" : "system",
      content: turn.content,
    })),
  ];

  try {
    const client = getPlannerClient();
    return await (client.responses as any).create(
      {
        model: config.plannerModel,
        input,
        tools: params.webSearchBudget > 0 ? [{ type: "web_search_preview" }] : [],
        text: {
          format: {
            type: "json_schema",
            name: schema.name,
            strict: true,
            schema: schema.schema,
          },
        },
      },
      { signal: controller.signal }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function callProviderRoleSuggestion(params: {
  title: string;
  brief?: string | null;
  comments?: string | null;
}): Promise<any> {
  const timeoutMs = Math.max(5_000, config.plannerRequestTimeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const brief = params.brief?.trim() ?? "";
  const comments = params.comments?.trim() ?? "";

  const input: Array<Record<string, unknown>> = [
    {
      role: "system",
      content:
        "You suggest role assignments for ChatGPT and Claude in a two-agent collab. " +
        "ChatGPT should lean creative exploration, ideation, and option generation. " +
        "Claude should lean technical rigor, constraints, validation, and tightening. " +
        "Return concise role instructions and pick who should start first. " +
        "Only return JSON matching the schema.",
    },
    {
      role: "user",
      content: [
        `Title: ${params.title.trim()}`,
        brief ? `Brief: ${brief}` : "",
        comments ? `Comments: ${comments}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];

  try {
    const client = getPlannerClient();
    return await (client.responses as any).create(
      {
        model: config.plannerModel,
        input,
        tools: [],
        text: {
          format: {
            type: "json_schema",
            name: providerRoleJsonSchema.name,
            strict: true,
            schema: providerRoleJsonSchema.schema,
          },
        },
      },
      { signal: controller.signal }
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function suggestProviderRoles(params: {
  title: string;
  brief?: string | null;
  comments?: string | null;
}): Promise<ProviderRoleSuggestion> {
  const response = await callProviderRoleSuggestion(params);
  const rawText = extractResponseText(response);
  const parsed = JSON.parse(rawText) as Record<string, unknown>;

  const chatgptRole = typeof parsed["chatgpt_role"] === "string" ? parsed["chatgpt_role"].trim() : "";
  const claudeRole = typeof parsed["claude_role"] === "string" ? parsed["claude_role"].trim() : "";
  const firstActor = parsed["first_actor_recommendation"] === "claude" ? "claude" : "chatgpt";

  if (!chatgptRole || !claudeRole) {
    throw new Error("Provider role suggestion was incomplete");
  }

  return {
    chatgpt_role: chatgptRole,
    claude_role: claudeRole,
    first_actor_recommendation: firstActor,
  };
}

export async function runPlannerStep(params: {
  mode: PlannerMode;
  goal: string;
  transcript: PlannerTurn[];
  webSearchBudget: number;
}): Promise<PlannerStepResult> {
  let response: any;
  let rawText = "";
  let parseError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await callPlanner(params);
    rawText = extractResponseText(response);
    try {
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      const webSearches = normalizeWebSearches(parsed["web_searches"]);

      if (parsed["kind"] === "plan") {
        return {
          kind: "plan",
          plan: normalizePlan(parsed["plan"]),
          web_searches: webSearches,
        };
      }

      if (typeof parsed["question"] === "string" && parsed["question"].trim().length > 0) {
        const maybePlan = parsed["plan"];
        if (maybePlan && params.mode === "finalize") {
          return {
            kind: "plan",
            plan: normalizePlan(maybePlan),
            web_searches: webSearches,
          };
        }
        return {
          kind: "question",
          question: parsed["question"].trim(),
          rationale: typeof parsed["rationale"] === "string" ? parsed["rationale"].trim() : "",
          web_searches: webSearches,
        };
      }

      if (parsed["plan"]) {
        return {
          kind: "plan",
          plan: normalizePlan(parsed["plan"]),
          web_searches: webSearches,
        };
      }

      throw new Error("Planner output did not include a question or plan");
    } catch (error) {
      parseError = error;
    }
  }

  const reason = parseError instanceof Error ? parseError.message : "unknown error";
  throw new Error(`Planner failed to return valid JSON: ${reason}${rawText ? `; output=${rawText.slice(0, 400)}` : ""}`);
}
