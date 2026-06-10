import type { ToolUseCase } from "./types.js";

export const TOOL_USE_CASES: ToolUseCase[] = [
  {
    name: "Research Newsletter",
    description: "Research recent news on a topic, then draft and send a newsletter email",
    requiredTools: ["internal.web_search", "internal.llm_only", "composio.resend.action.resend_send_email"],
    outcome: "A researched, drafted, and sent newsletter email to subscribers",
    category: "research",
  },
  {
    name: "Memory-Based Draft",
    description: "Recall relevant memories, then draft content based on stored context",
    requiredTools: ["internal.memory_search", "internal.llm_only"],
    outcome: "A draft informed by past interactions and validated memories",
    category: "communication",
  },
  {
    name: "GitHub Notification",
    description: "Search GitHub for updates, then notify team via Slack",
    requiredTools: ["composio.github.search", "composio.slack.action.send_message"],
    outcome: "Team notified of GitHub activity via Slack message",
    category: "automation",
  },
  {
    name: "Calendar Summary",
    description: "Retrieve upcoming calendar events, then draft a summary email",
    requiredTools: ["composio.googlecalendar.search", "internal.llm_only", "composio.resend.action.resend_send_email"],
    outcome: "Email summary of upcoming calendar events sent to team",
    category: "automation",
  },
  {
    name: "Notion to Email",
    description: "Search Notion for specific content, then email it to stakeholders",
    requiredTools: ["composio.notion.search", "internal.llm_only", "composio.resend.action.resend_send_email"],
    outcome: "Notion content summarized and emailed to stakeholders",
    category: "communication",
  },
  {
    name: "Linear Task Update",
    description: "Search Linear for tasks, then update or create new tasks based on findings",
    requiredTools: ["composio.linear.search", "composio.linear.action.create_task"],
    outcome: "Linear tasks updated or created based on research",
    category: "automation",
  },
  {
    name: "Web Research Only",
    description: "Research a topic via web search, return raw results for downstream processing",
    requiredTools: ["internal.web_search"],
    outcome: "Raw web search results with URLs, titles, and summaries",
    category: "research",
  },
  {
    name: "Memory Recall Only",
    description: "Search memories for specific context, return validated memories",
    requiredTools: ["internal.memory_search"],
    outcome: "Array of validated memories with IDs and excerpts",
    category: "research",
  },
  {
    name: "Draft and Review",
    description: "Draft content from context, then pause for human review before sending",
    requiredTools: ["internal.llm_only"],
    outcome: "Draft content ready for human approval",
    category: "communication",
  },
  {
    name: "Multi-Source Research",
    description: "Research from web, GitHub, and Notion, then synthesize into a report",
    requiredTools: ["internal.web_search", "composio.github.search", "composio.notion.search", "internal.llm_only"],
    outcome: "Comprehensive report synthesized from multiple sources",
    category: "research",
  },
];

export function getUseCasesByCategory(category: ToolUseCase["category"]): ToolUseCase[] {
  return TOOL_USE_CASES.filter((uc) => uc.category === category);
}

export function getUseCasesByTool(toolRef: string): ToolUseCase[] {
  return TOOL_USE_CASES.filter((uc) => uc.requiredTools.some((t) => t.includes(toolRef) || toolRef.includes(t)));
}
