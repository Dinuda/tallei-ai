export type ShowcaseLoop = {
  id: string;
  title: string;
  intent: string;
  cadence: string;
  category: "work" | "content" | "ops";
  agents: string[];
  outputPreview?: string;
};

export const SHOWCASE_LOOPS: ShowcaseLoop[] = [
  {
    id: "changelog",
    title: "Weekly Changelog",
    intent: "Summarize what we shipped and post to Slack",
    cadence: "Every Friday",
    category: "work",
    agents: ["Researcher", "Writer", "Publisher"],
    outputPreview: "Shipped: memory sync, loop builder v3, dashboard refresh…",
  },
  {
    id: "newsletter",
    title: "Newsletter Draft",
    intent: "Draft my weekly newsletter from saved reads",
    cadence: "Every Sunday",
    category: "content",
    agents: ["Curator", "Writer", "Reviewer"],
    outputPreview: "This week: three essays on agent memory, one hot take on MCP…",
  },
  {
    id: "inbox",
    title: "Inbox Triage",
    intent: "Sort my inbox, flag urgent, draft replies",
    cadence: "Daily 8am",
    category: "ops",
    agents: ["Classifier", "Drafter", "Gate"],
    outputPreview: "3 urgent · 12 queued · 2 drafts ready for review",
  },
  {
    id: "meeting",
    title: "Meeting Prep",
    intent: "Brief me before every calendar meeting",
    cadence: "30 min before",
    category: "work",
    agents: ["Calendar", "Researcher", "Summarizer"],
    outputPreview: "Q3 planning — attendees, last notes, open questions",
  },
  {
    id: "competitor",
    title: "Competitor Watch",
    intent: "Track competitor launches and alert me",
    cadence: "Weekly",
    category: "ops",
    agents: ["Crawler", "Analyst", "Notifier"],
    outputPreview: "2 new features spotted · 1 pricing change",
  },
  {
    id: "writing",
    title: "Writing Companion",
    intent: "Help me finish my draft in my voice",
    cadence: "On demand",
    category: "content",
    agents: ["Memory", "Editor", "Critic"],
    outputPreview: "Tone matched · 3 paragraphs refined · ready to publish",
  },
];

export const HERO_INTENT =
  "Send my team a weekly summary of what we shipped";

export const HERO_LOOP_CANDIDATES = [
  { title: "Weekly Digest", agents: ["Researcher", "Writer", "Sender"], selected: true },
  { title: "Email Broadcast", agents: ["Curator", "Writer"], selected: false },
  { title: "Slack Standup", agents: ["Summarizer", "Publisher"], selected: false },
  { title: "Project Retro", agents: ["Analyst", "Writer"], selected: false },
];
