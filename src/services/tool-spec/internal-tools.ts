import type { ToolSpec } from "./types.js";

export const INTERNAL_TOOL_SPECS: ToolSpec[] = [
  {
    ref: "internal.llm_only",
    label: "LLM Synthesis",
    provider: "internal",
    description: "Pure language model reasoning and text generation. No external API calls. Used for drafting, summarizing, analyzing, and transforming content from prior agent outputs.",
    shortCircuits: false,
    outputDescription: "Generated text content (drafts, summaries, analyses, etc.)",
    outputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Generated text content" }
      },
      required: ["text"]
    },
    handoffFormat: "Output text is passed as `handoff.<agent_id>.text` to downstream agents. For email/newsletter agents, also set renderTarget `canvas.email`, artifactRole `draft_body`, and gate `draft_review` so the draft renders in the canvas for human review.",
    useCases: [
      "Draft an email from research findings",
      "Summarize multiple agent outputs into a cohesive report",
      "Transform raw data into structured format",
      "Generate creative content based on context",
      "Analyze and synthesize information from prior steps"
    ],
    limitations: [
      "Cannot access external data sources",
      "Cannot execute actions or make API calls",
      "Relies entirely on context provided by prior agents",
      "Output quality depends on input quality"
    ],
    risk: "none",
    requiresConnector: false,
    requiresPreSendApproval: false
  },
  {
    ref: "internal.memory_search",
    label: "Memory Search",
    provider: "internal",
    description: "Semantic search across user's stored memories and past interactions. Returns validated memories with IDs, excerpts, and relevance scores. Short-circuits: raw search results are returned without LLM synthesis.",
    shortCircuits: true,
    outputDescription: "Array of memory objects with IDs, excerpts, and metadata",
    outputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Formatted text summary of memory search results" },
        data: {
          type: "object",
          properties: {
            sources: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Memory ID" },
                  text: { type: "string", description: "Memory excerpt" },
                  score: { type: "number", description: "Relevance score" },
                  confidence: { type: "string", description: "Confidence level" },
                  reason: { type: "string", description: "Reason for inclusion" }
                },
                required: ["id", "text"]
              }
            }
          }
        }
      },
      required: ["text", "data"]
    },
    handoffFormat: "Output is passed as `handoff.<agent_id>` to downstream agents. Downstream agents receive the full object with `text` (formatted summary) and `data.sources` (array of memory objects with id, text, score, confidence, reason).",
    useCases: [
      "Recall user preferences and past decisions",
      "Find relevant historical context for current task",
      "Retrieve past project updates or notes",
      "Access stored opinions or validated facts",
      "Gather context from previous conversations"
    ],
    limitations: [
      "Only searches memories already stored in the system",
      "Results depend on memory quality and relevance scoring",
      "May return zero results if no relevant memories exist",
      "Cannot access real-time or external data",
      "Short-circuits: no LLM synthesis applied to results"
    ],
    risk: "none",
    requiresConnector: false,
    requiresPreSendApproval: false
  },
  {
    ref: "internal.web_search",
    label: "Web Search",
    provider: "internal",
    description: "Search the web for recent articles, news, and information using Exa API. Returns raw search results with URLs, titles, and snippets. Short-circuits: raw search results are returned without LLM synthesis.",
    shortCircuits: true,
    outputDescription: "Search results object with text summary and structured sources array",
    outputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Formatted text summary of search results" },
        model: { type: "string", const: "exa-search" },
        provider: { type: "string", const: "exa_web_search" },
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Article or page title" },
              url: { type: "string", description: "Source URL" },
              snippet: { type: "string", description: "Summary or highlight snippet (max 320 chars)" }
            },
            required: ["title", "url", "snippet"]
          },
          description: "Array of search results (typically 4-8 items)"
        }
      },
      required: ["text", "model", "provider", "sources"]
    },
    handoffFormat: "Output is passed as `handoff.<agent_id>` to downstream agents. Downstream agents receives the full object with `text` (formatted summary) and `sources` (array of {title, url, snippet}).",
    useCases: [
      "Research recent news and industry trends",
      "Find current information on a topic",
      "Gather source material for content creation",
      "Verify facts with external sources",
      "Collect URLs and references for citations"
    ],
    limitations: [
      "Returns raw search results only (no synthesis)",
      "Quality depends on search query specificity",
      "May include irrelevant or low-quality sources",
      "Limited to publicly accessible web content",
      "Short-circuits: no LLM synthesis applied to results",
      "Downstream agents must synthesize and structure the raw data"
    ],
    risk: "none",
    requiresConnector: false,
    requiresPreSendApproval: false
  },
];

export function getInternalToolSpec(ref: string): ToolSpec | undefined {
  return INTERNAL_TOOL_SPECS.find((tool) => tool.ref === ref);
}
