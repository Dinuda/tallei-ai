import type { LoopTemplate } from "./types.js";

export const newsletterBroadcastTemplate: LoopTemplate = {
  id: "newsletter_broadcast",
  label: "Newsletter Broadcast",
  description: "Subscriber-facing newsletter with distinct writing, email build, approval, and broadcast delivery steps.",
  tags: ["newsletter", "email", "broadcast", "subscribers", "weekly"],
  highPotential: true,
  summary: [
    "Benchmark for subscriber email loops: same research pipeline as Writing Companion,",
    "plus separate Email Build and Approval agents,",
    "then a separate broadcast delivery step that only syncs recipients and sends the approved broadcast.",
    "Use deliveryType newsletter for bespoke subscriber loops; never set presetId from this inspiration pattern.",
  ].join(" "),
  whenToUse: "Borrow when the user wants a recurring newsletter or email blast to subscribers with broadcast delivery.",
  suggestedTools: [
    "internal.memory_search",
    "internal.web_search",
    "internal.llm_only",
    "internal.email_approval_request",
    "internal.email_builder_compose",
    "internal.email_builder_render",
    "internal.resend_broadcast",
  ],
  exampleAgents: [
    {
      id: "search_agent",
      name: "Search Agent",
      task: "Search memory for previous issues, voice, tone, formatting, editorial preferences, and verified product/company updates. If no relevant memory is found, say `No verified memory evidence found`; do not create placeholders or sample updates.",
      tools: ["internal.memory_search"],
    },
    {
      id: "web_search_agent",
      name: "Web Search Agent",
      task: "Gather source-grounded evidence for topic candidates from this week's news.",
      tools: ["internal.web_search"],
    },
    {
      id: "research_agent",
      name: "Research Agent",
      task: "Produce writer briefing with selected topic, citations, voice guidance, and a strict verified-facts list. Separate missing/unverified product facts from safe-to-use facts; do not pass placeholders to the writer as usable material.",
      tools: ["internal.llm_only"],
    },
    {
      id: "writer",
      name: "Newsletter Writer",
      task: "Write one subscriber-ready email draft only. Line 1 must be `Subject: <one subject>` and line 2 may be `Preview: <one preview>`. Use only verified facts from prior agents. Omit product update sections if product evidence is missing. Do not include subject options, alternate versions, social snippets, notes, or internal handoff text.",
      tools: ["internal.llm_only"],
    },
    {
      id: "email_build",
      name: "Email Build Agent",
      task: "Compose and render the visual email from the writer draft only. Do not send approval requests or broadcast.",
      tools: ["internal.email_builder_compose", "internal.email_builder_render"],
    },
    {
      id: "approval",
      name: "Approval Agent",
      task: "Ask the operator to review the draft and send the approval request only. Do not build email HTML or broadcast.",
      tools: ["internal.email_approval_request"],
    },
    {
      id: "broadcast_delivery",
      name: "Broadcast Delivery Agent",
      task: "After approval and recipient upload, sync contacts and submit the approved Resend broadcast only. Do not write, approve, or build email HTML.",
      tools: ["internal.resend_broadcast"],
    },
  ],
  deliveryTypeHint: "newsletter",
};
