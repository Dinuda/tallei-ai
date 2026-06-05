import type { LoopTemplate } from "./types.js";

export const writingCompanionTemplate: LoopTemplate = {
  id: "writing_companion",
  label: "Writing Companion",
  description: "Memory-grounded research → brief → writer → approval handoff for recurring written content.",
  tags: ["writing", "content", "blog", "essay", "report", "draft"],
  highPotential: true,
  summary: [
    "Quality bar for writing loops: five specialist agents that do real work before any delivery.",
    "1) Memory Search — prior writing, voice, tone, format, audience, recurring sections.",
    "2) Source Research — timely sources and evidence for topic candidates (web search when needed).",
    "3) Research Brief — pick one lead topic, pass voice/style verbatim to the writer.",
    "4) Writer — final draft matching memory voice; no internal handoff notes in output.",
    "5) Approval Handoff — send draft for operator approval before any publish/send action.",
  ].join(" "),
  whenToUse: "Borrow when the user wants recurring written content (essays, posts, reports, updates) grounded in their voice and memory.",
  suggestedTools: [
    "internal.memory_search",
    "internal.web_search",
    "internal.llm_only",
    "internal.email_approval_request",
  ],
  exampleAgents: [
    {
      id: "memory_search",
      name: "Memory Search",
      task: "Search memory for prior writing, voice, tone, formatting, audience, and editorial preferences.",
      tools: ["internal.memory_search"],
    },
    {
      id: "source_research",
      name: "Source Research",
      task: "Gather timely source material and evidence for topic candidates.",
      tools: ["internal.web_search"],
    },
    {
      id: "research_brief",
      name: "Research Brief",
      task: "Synthesize into a writer briefing: selected topic, why now, arguments, citations, voice guidance.",
      tools: ["internal.llm_only"],
    },
    {
      id: "writer",
      name: "Writer",
      task: "Write the final draft using the briefing; match memory voice precisely.",
      tools: ["internal.llm_only"],
    },
    {
      id: "approval_handoff",
      name: "Approval Handoff",
      task: "Send the draft to the operator for approval before delivery.",
      tools: ["internal.email_approval_request"],
    },
  ],
  deliveryTypeHint: "plain",
};
