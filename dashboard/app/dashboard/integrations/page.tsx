"use client";

import { useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Search,
  CheckCircle2,
  XCircle,
  Trash2,
  Sparkles,
  X,
  Zap,
  Plus,
  Command,
  ArrowRight,
} from "lucide-react";
import styles from "./page.module.css";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */
type ConnectorAccount = {
  id: string;
  provider: string;
  appKey?: string | null;
  externalAccountId: string;
  status: string;
  scopes: string[];
  updatedAt: string;
};

type AppCategory =
  | "All"
  | "Communication"
  | "Scheduling"
  | "Social"
  | "Development"
  | "Productivity"
  | "Storage";

type AppDef = {
  key: string;
  name: string;
  description: string;
  category: AppCategory;
  scopes: string[];
  color: string;
  icon: React.ComponentType<{ size?: number }>;
};

/* ------------------------------------------------------------------ */
/* Artistic brand icons (custom premium SVGs)                          */
/* ------------------------------------------------------------------ */

function GmailIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <defs>
        <linearGradient id="gmailGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FF6B6B" />
          <stop offset="1" stopColor="#EA4335" />
        </linearGradient>
      </defs>
      <rect x="4" y="10" width="40" height="28" rx="6" fill="url(#gmailGrad)" />
      <path d="M4 16l20 14 20-14" stroke="rgba(255,255,255,0.9)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 16v22" stroke="rgba(255,255,255,0.7)" strokeWidth="2" />
      <path d="M44 16v22" stroke="rgba(255,255,255,0.7)" strokeWidth="2" />
    </svg>
  );
}

function SlackIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <rect width="48" height="48" rx="12" fill="#4A154B" />
      <circle cx="17" cy="17" r="5" fill="#E01E5A" />
      <circle cx="31" cy="17" r="5" fill="#36C5F0" />
      <circle cx="17" cy="31" r="5" fill="#2EB67D" />
      <circle cx="31" cy="31" r="5" fill="#ECB22E" />
      <circle cx="17" cy="17" r="2" fill="#4A154B" />
      <circle cx="31" cy="17" r="2" fill="#4A154B" />
      <circle cx="17" cy="31" r="2" fill="#4A154B" />
      <circle cx="31" cy="31" r="2" fill="#4A154B" />
    </svg>
  );
}

function TeamsIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <defs>
        <linearGradient id="teamsGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7B83EB" />
          <stop offset="1" stopColor="#6264A7" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#teamsGrad)" />
      <circle cx="18" cy="19" r="7" fill="rgba(255,255,255,0.9)" />
      <path d="M10 38c0-6 5-10 10-10h4c5 0 10 4 10 10v2H10v-2Z" fill="rgba(255,255,255,0.9)" />
      <circle cx="34" cy="15" r="5" fill="rgba(255,255,255,0.6)" />
      <path d="M30 30h8v4c0 3-2.2 5-4 5s-4-2-4-5v-4Z" fill="rgba(255,255,255,0.6)" />
    </svg>
  );
}

function DiscordIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <rect width="48" height="48" rx="14" fill="#5865F2" />
      <path d="M18.5 20c-1.4 0-2.5 1.1-2.5 2.5s1.1 2.5 2.5 2.5 2.5-1.1 2.5-2.5-1.1-2.5-2.5-2.5Zm11 0c-1.4 0-2.5 1.1-2.5 2.5s1.1 2.5 2.5 2.5 2.5-1.1 2.5-2.5-1.1-2.5-2.5-2.5Z" fill="#fff" />
      <path d="M14 16c4-2 8-2.5 12-2.5s8 .5 12 2.5c0 0 2 10-2 14-2 2-5 3-8 3.5l-1-1.5c2.5-.5 4.5-1.5 6-3-2 1-4.5 1.5-7 1.5s-5-.5-7-1.5c1.5 1.5 3.5 2.5 6 3l-1 1.5c-3-.5-6-1.5-8-3.5-4-4-2-14-2-14Z" fill="#fff" />
    </svg>
  );
}

function GCalIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <rect x="4" y="6" width="40" height="36" rx="6" fill="#fff" stroke="#E8EAED" strokeWidth="2" />
      <rect x="4" y="14" width="40" height="2" fill="#E8EAED" />
      <rect x="12" y="4" width="6" height="6" rx="2" fill="#EA4335" />
      <rect x="30" y="4" width="6" height="6" rx="2" fill="#EA4335" />
      <rect x="10" y="22" width="6" height="6" rx="1.5" fill="#4285F4" />
      <rect x="21" y="22" width="6" height="6" rx="1.5" fill="#EA4335" />
      <rect x="32" y="22" width="6" height="6" rx="1.5" fill="#34A853" />
      <rect x="10" y="32" width="6" height="6" rx="1.5" fill="#FBBC04" />
      <rect x="21" y="32" width="6" height="6" rx="1.5" fill="#4285F4" />
      <rect x="32" y="32" width="6" height="6" rx="1.5" fill="#EA4335" />
    </svg>
  );
}

function OutlookIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <defs>
        <linearGradient id="outlookGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0A8BD9" />
          <stop offset="1" stopColor="#0078D4" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="10" fill="url(#outlookGrad)" />
      <rect x="8" y="14" width="20" height="20" rx="4" fill="rgba(255,255,255,0.15)" />
      <rect x="12" y="20" width="12" height="2.5" rx="1" fill="rgba(255,255,255,0.8)" />
      <rect x="12" y="26" width="8" height="2.5" rx="1" fill="rgba(255,255,255,0.5)" />
      <path d="M28 18l10-4v20l-10-4V18Z" fill="rgba(255,255,255,0.25)" />
      <path d="M28 18l10 6-10 6" stroke="rgba(255,255,255,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CalendlyIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <defs>
        <linearGradient id="calGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2B8CFF" />
          <stop offset="1" stopColor="#006BFF" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#calGrad)" />
      <circle cx="24" cy="24" r="12" stroke="rgba(255,255,255,0.9)" strokeWidth="3" />
      <path d="M24 16v8.5l6 3.5" stroke="rgba(255,255,255,0.9)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TwitterIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <rect width="48" height="48" rx="12" fill="#000" />
      <path d="M26.5 20.5L34 12h-2l-6 6.5L21 12h-6l8 11-8 9h2l6.5-7 5.5 7H31l-8.5-11.5Z" fill="#fff" />
    </svg>
  );
}

function LinkedInIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <defs>
        <linearGradient id="liGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0A76D9" />
          <stop offset="1" stopColor="#0A66C2" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="8" fill="url(#liGrad)" />
      <rect x="12" y="20" width="5" height="18" rx="1" fill="#fff" />
      <circle cx="14.5" cy="14.5" r="3" fill="#fff" />
      <path d="M21 20h5v2.5c.5-1 2.5-2.5 4-2.5 4 0 6 2.5 6 7V38h-5v-9c0-2-1-4-3-4s-3 2-3 4v9h-5V20Z" fill="#fff" />
    </svg>
  );
}

function GitHubIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <rect width="48" height="48" rx="14" fill="#181717" />
      <path d="M24 8c-8.8 0-16 7.2-16 16 0 7 4.5 13 10.8 15.2.8.2 1.1-.4 1.1-.8v-2.8c-4.4 1-5.3-1.8-5.3-1.8-.7-1.8-1.8-2.3-1.8-2.3-1.5-1 .1-1 .1-1 1.6.1 2.5 1.7 2.5 1.7 1.5 2.5 3.8 1.8 4.7 1.4.1-1.1.6-1.8 1-2.2-3.5-.4-7.2-1.8-7.2-7.9 0-1.7.6-3.2 1.6-4.3-.2-.4-.7-2 .2-4.2 0 0 1.3-.4 4.3 1.6a14.8 14.8 0 0 1 8 0c3-2 4.3-1.6 4.3-1.6.8 2.2.3 3.8.2 4.2 1 1 1.6 2.5 1.6 4.3 0 6.2-3.7 7.5-7.3 7.9.6.5 1.1 1.5 1.1 3V38c0 .5.3.9 1 .8C35.5 37 40 31 40 24c0-8.8-7.2-16-16-16Z" fill="#fff" />
    </svg>
  );
}

function GitLabIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <rect width="48" height="48" rx="12" fill="#FC6D26" />
      <path d="M24 40l-8-18h16l-8 18Z" fill="#E24329" />
      <path d="M24 40L8 22h8l8 18Z" fill="#FCA326" />
      <path d="M24 40l16-18h-8l-8 18Z" fill="#FC6D26" />
      <path d="M8 22l4-10h4L8 22Z" fill="#E24329" />
      <path d="M40 22l-4-10h-4L40 22Z" fill="#FCA326" />
      <path d="M16 12h16L24 40 16 12Z" fill="#FC6D26" />
    </svg>
  );
}

function LinearIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <defs>
        <linearGradient id="linGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8B93F6" />
          <stop offset="1" stopColor="#5E6AD2" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="10" fill="url(#linGrad)" />
      <path d="M12 36L32 16M28 12h8v8" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function JiraIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <rect width="48" height="48" rx="10" fill="#0052CC" />
      <path d="M24 10h10a6 6 0 0 1 6 6v10H24V10Z" fill="#2684FF" />
      <path d="M24 26v10a6 6 0 0 1-6 6H8a6 6 0 0 1-6-6V26h22Z" fill="#2684FF" opacity="0.6" />
    </svg>
  );
}

function NotionIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <rect width="48" height="48" rx="10" fill="#000" />
      <path d="M12 10l20-1.5 6 4-20 1.5-6-4Z" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 16v24l18 1.5V17.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M26 16l-4 25" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function AsanaIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <defs>
        <linearGradient id="asanaGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FF8A8A" />
          <stop offset="1" stopColor="#F06A6A" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#asanaGrad)" />
      <circle cx="17" cy="18" r="6" fill="#fff" />
      <circle cx="31" cy="18" r="6" fill="#fff" />
      <path d="M17 28c0 4 3 7 7 7s7-3 7-7" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function TrelloIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <defs>
        <linearGradient id="trelloGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1BA1F2" />
          <stop offset="1" stopColor="#0079BF" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="10" fill="url(#trelloGrad)" />
      <rect x="10" y="10" width="10" height="28" rx="3" fill="#fff" opacity="0.9" />
      <rect x="28" y="10" width="10" height="16" rx="3" fill="#fff" opacity="0.5" />
    </svg>
  );
}

function GDriveIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <path d="M16 6l-8 14h12l8-14H16Z" fill="#0066DA" />
      <path d="M32 6l-8 14h12l8-14H32Z" fill="#00AC47" />
      <path d="M4 34l6 8h12l-6-8H4Z" fill="#FFBA00" />
      <path d="M20 34l6 8h12l-6-8H20Z" fill="#00832D" />
      <path d="M12 28h12l6 8H18l-6-8Z" fill="#2684FC" />
      <path d="M28 28h12l6 8H34l-6-8Z" fill="#EA4335" />
    </svg>
  );
}

function DropboxIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <defs>
        <linearGradient id="dropGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2B8CFF" />
          <stop offset="1" stopColor="#0061FF" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="10" fill="url(#dropGrad)" />
      <path d="M16 12l8 6-8 6-8-6 8-6ZM32 12l8 6-8 6-8-6 8-6ZM8 24l8 6 8-6-8-6-8 6ZM24 24l8 6 8-6-8-6-8 6ZM16 30l8 6 8-6" stroke="#fff" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}

function OneDriveIcon({ size = 20 }: { size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <defs>
        <linearGradient id="odGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2B9DFF" />
          <stop offset="1" stopColor="#0078D4" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="10" fill="url(#odGrad)" />
      <path d="M10 32c0-5 4-8 8-8h2c3 0 5-2 5-5 0-3-2-5-5-5h-1c-3 0-5 2-5 5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <path d="M14 30c0-4 3.5-6 6.5-6h3c3 0 5.5-2.5 5.5-5.5S27 13 24 13c-2 0-3.8 1-4.8 2.5" stroke="rgba(255,255,255,0.6)" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M38 32c0-3.5-2.8-6.2-6-6.2-1.5 0-2.8.5-3.8 1.4" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* App definitions                                                     */
/* ------------------------------------------------------------------ */
const CATEGORIES: AppCategory[] = [
  "All",
  "Communication",
  "Scheduling",
  "Social",
  "Development",
  "Productivity",
  "Storage",
];

const PENDING_CONNECTOR_KEY = "tallei:pending-connector-auth";

type PendingConnectorAuth = {
  appKey: string;
  authSessionId?: string;
  scopes?: string[];
  startedAt: number;
};

const APPS: AppDef[] = [
  {
    key: "gmail",
    name: "Gmail",
    description: "Send emails, manage labels, and search your inbox.",
    category: "Communication",
    scopes: ["gmail.send_email"],
    color: "#EA4335",
    icon: GmailIcon,
  },
  {
    key: "slack",
    name: "Slack",
    description: "Post messages and manage channels.",
    category: "Communication",
    scopes: ["slack.post_message"],
    color: "#4A154B",
    icon: SlackIcon,
  },
  {
    key: "msteams",
    name: "Microsoft Teams",
    description: "Send messages and manage team conversations.",
    category: "Communication",
    scopes: [],
    color: "#6264A7",
    icon: TeamsIcon,
  },
  {
    key: "discord",
    name: "Discord",
    description: "Send messages to channels and servers.",
    category: "Communication",
    scopes: [],
    color: "#5865F2",
    icon: DiscordIcon,
  },
  {
    key: "googlecalendar",
    name: "Google Calendar",
    description: "Create events and manage your schedule.",
    category: "Scheduling",
    scopes: ["googlecalendar.create_event"],
    color: "#4285F4",
    icon: GCalIcon,
  },
  {
    key: "outlook",
    name: "Outlook Calendar",
    description: "Create and manage calendar events.",
    category: "Scheduling",
    scopes: [],
    color: "#0078D4",
    icon: OutlookIcon,
  },
  {
    key: "calendly",
    name: "Calendly",
    description: "Schedule meetings and manage availability.",
    category: "Scheduling",
    scopes: [],
    color: "#006BFF",
    icon: CalendlyIcon,
  },
  {
    key: "twitter",
    name: "Twitter / X",
    description: "Post tweets and manage your timeline.",
    category: "Social",
    scopes: [],
    color: "#000000",
    icon: TwitterIcon,
  },
  {
    key: "linkedin",
    name: "LinkedIn",
    description: "Share posts and manage your professional presence.",
    category: "Social",
    scopes: [],
    color: "#0A66C2",
    icon: LinkedInIcon,
  },
  {
    key: "github",
    name: "GitHub",
    description: "Create issues, PRs, and manage repositories.",
    category: "Development",
    scopes: ["github.create_issue"],
    color: "#181717",
    icon: GitHubIcon,
  },
  {
    key: "gitlab",
    name: "GitLab",
    description: "Manage issues, merge requests, and projects.",
    category: "Development",
    scopes: [],
    color: "#FC6D26",
    icon: GitLabIcon,
  },
  {
    key: "linear",
    name: "Linear",
    description: "Create issues and manage project workflows.",
    category: "Development",
    scopes: [],
    color: "#5E6AD2",
    icon: LinearIcon,
  },
  {
    key: "jira",
    name: "Jira",
    description: "Create tickets and track project progress.",
    category: "Development",
    scopes: [],
    color: "#0052CC",
    icon: JiraIcon,
  },
  {
    key: "notion",
    name: "Notion",
    description: "Create pages and manage your workspace.",
    category: "Productivity",
    scopes: ["notion.create_page"],
    color: "#000000",
    icon: NotionIcon,
  },
  {
    key: "asana",
    name: "Asana",
    description: "Create tasks and manage team projects.",
    category: "Productivity",
    scopes: [],
    color: "#F06A6A",
    icon: AsanaIcon,
  },
  {
    key: "trello",
    name: "Trello",
    description: "Create cards and manage boards.",
    category: "Productivity",
    scopes: [],
    color: "#0079BF",
    icon: TrelloIcon,
  },
  {
    key: "gdrive",
    name: "Google Drive",
    description: "Upload and manage files in your Drive.",
    category: "Storage",
    scopes: [],
    color: "#34A853",
    icon: GDriveIcon,
  },
  {
    key: "dropbox",
    name: "Dropbox",
    description: "Upload and sync files across devices.",
    category: "Storage",
    scopes: [],
    color: "#0061FF",
    icon: DropboxIcon,
  },
  {
    key: "onedrive",
    name: "OneDrive",
    description: "Store and share files from the cloud.",
    category: "Storage",
    scopes: [],
    color: "#0078D4",
    icon: OneDriveIcon,
  },
];

const RECOMMENDED_KEYS = ["gmail", "slack", "googlecalendar", "github", "notion"];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function inferAppKeyFromScopes(scopes: string[]): string | null {
  const first = scopes.find((scope) => scope.trim().length > 0)?.trim().toLowerCase();
  if (!first) return null;

  if (first.startsWith("https://www.googleapis.com/auth/")) {
    const service = first.replace("https://www.googleapis.com/auth/", "").split(".")[0];
    if (service === "gmail" || service === "mail") return "gmail";
    if (service === "calendar") return "googlecalendar";
    return service || null;
  }

  if (first.includes("google.com") || first.includes("googleapis.com")) {
    if (first.includes("mail")) return "gmail";
    if (first.includes("calendar")) return "googlecalendar";
    return "google";
  }

  return first.split(/[.:/]/)[0] || null;
}

function resolveConnectorKey(account: ConnectorAccount): string | null {
  const metadataKey = typeof account.appKey === "string" ? account.appKey.trim().toLowerCase() : "";
  if (metadataKey.length > 0) return metadataKey;
  const providerKey = account.provider.trim().toLowerCase();
  if (providerKey.length > 0 && providerKey !== "composio") return providerKey;
  return inferAppKeyFromScopes(account.scopes);
}

function readPendingConnectorAuth(): PendingConnectorAuth | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_CONNECTOR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingConnectorAuth>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.appKey !== "string" || parsed.appKey.trim().length === 0) return null;
    return {
      appKey: parsed.appKey,
      authSessionId: typeof parsed.authSessionId === "string" ? parsed.authSessionId : undefined,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((v): v is string => typeof v === "string") : undefined,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function useKeydown(key: string, handler: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === key) handler();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, handler]);
}

/* ------------------------------------------------------------------ */
/* Main page                                                           */
/* ------------------------------------------------------------------ */
export default function ConnectedAppsPage() {
  const [connectors, setConnectors] = useState<ConnectorAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  async function load(options?: { connectionCheck?: boolean }) {
    setError(null);
    if (options?.connectionCheck) setCheckingConnection(true);
    try {
      const res = await fetch("/api/connectors", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load connected apps");
      setConnectors(Array.isArray(data.connectors) ? data.connectors : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load connected apps");
    } finally {
      setLoading(false);
      setRefreshing(false);
      if (options?.connectionCheck) setCheckingConnection(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const returnedFromAuth = params.get("connector_return") === "1";
    const pendingAuth = readPendingConnectorAuth();
    const hadPendingAuth = pendingAuth !== null;
    const shouldCheckConnection = returnedFromAuth || hadPendingAuth;

    async function continuePendingAuth(pending: PendingConnectorAuth): Promise<void> {
      if (!pending.authSessionId) return;
      await fetch(`/api/connectors/auth-sessions/${pending.authSessionId}/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scopes: pending.scopes ?? [pending.appKey],
        }),
      });
    }

    if (returnedFromAuth) {
      params.delete("connector_return");
      params.delete("app");
      const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", nextUrl);
    }

    async function checkAndLoad(pending: PendingConnectorAuth | null) {
      if (pending) {
        try {
          await continuePendingAuth(pending);
        } catch {
          // best effort: load status from backend regardless
        } finally {
          window.sessionStorage.removeItem(PENDING_CONNECTOR_KEY);
        }
      }

      if (shouldCheckConnection) {
        setRefreshing(true);
        await load({ connectionCheck: true });
      } else {
        await load();
      }
    }

    void checkAndLoad(pendingAuth);

    function checkPendingConnection() {
      if (document.visibilityState !== "visible") return;
      const pending = readPendingConnectorAuth();
      if (!pending) return;
      void checkAndLoad(pending);
    }

    window.addEventListener("focus", checkPendingConnection);
    document.addEventListener("visibilitychange", checkPendingConnection);
    return () => {
      window.removeEventListener("focus", checkPendingConnection);
      document.removeEventListener("visibilitychange", checkPendingConnection);
    };
  }, []);

  const connectedApps = useMemo(() => {
    return connectors
      .map((c) => {
        const app = APPS.find((a) => a.key === resolveConnectorKey(c));
        return app ? { ...c, app } : null;
      })
      .filter(Boolean) as (ConnectorAccount & { app: AppDef })[];
  }, [connectors]);

  const recommendedApps = useMemo(() => {
    const connectedKeys = new Set(connectors.map((c) => resolveConnectorKey(c)).filter((k): k is string => !!k));
    return APPS.filter((a) => RECOMMENDED_KEYS.includes(a.key) && !connectedKeys.has(a.key));
  }, [connectors]);

  async function startAuth(app: AppDef) {
    setBusyKey(app.key);
    setError(null);
    try {
      const redirectUrl = new URL("/dashboard/integrations", window.location.origin);
      redirectUrl.searchParams.set("connector_return", "1");
      redirectUrl.searchParams.set("app", app.key);
      window.sessionStorage.setItem(
        PENDING_CONNECTOR_KEY,
        JSON.stringify({ appKey: app.key, startedAt: Date.now() })
      );

      const res = await fetch("/api/connectors/composio/auth-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_key: app.key,
          required_scopes: app.scopes,
          redirect_uri: redirectUrl.toString(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to start connection");
      const authSessionId = typeof data?.auth_session_id === "string" ? data.auth_session_id : null;
      const nextSetupUrl = typeof data?.setup_url === "string" ? data.setup_url : null;
      if (!nextSetupUrl) throw new Error("Missing setup URL from connector response");
      if (authSessionId) {
        window.sessionStorage.setItem(
          PENDING_CONNECTOR_KEY,
          JSON.stringify({
            appKey: app.key,
            authSessionId,
            scopes: app.scopes,
            startedAt: Date.now(),
          } satisfies PendingConnectorAuth)
        );
      }
      window.location.assign(nextSetupUrl);
    } catch (e) {
      window.sessionStorage.removeItem(PENDING_CONNECTOR_KEY);
      setError(e instanceof Error ? e.message : "Failed to start connection");
      setBusyKey(null);
    }
  }

  async function disconnect(accountId: string) {
    setBusyKey(`disconnect-${accountId}`);
    setError(null);
    try {
      const res = await fetch(`/api/connectors/${accountId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to disconnect");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Connected Apps</h1>
          <p className={styles.pageSubtitle}>
            Link your favorite tools so Tallei can act on your behalf.
          </p>
        </div>
        <div className={styles.headerRight}>
          <button
            type="button"
            className={styles.refreshBtn}
            onClick={() => {
              setRefreshing(true);
              void load();
            }}
            disabled={loading || refreshing}
            title="Refresh connections"
          >
            <RefreshCw size={16} className={refreshing ? styles.spin : ""} />
          </button>
          <button
            type="button"
            className={styles.addBtn}
            onClick={() => setAddOpen(true)}
          >
            <Plus size={16} />
            Add app
          </button>
        </div>
      </header>

      {error ? (
        <div className={styles.bannerError}>
          <XCircle size={14} />
          {error}
        </div>
      ) : null}

      {checkingConnection ? (
        <div className={styles.setupBanner}>
          <RefreshCw size={14} className={styles.spin} />
          Checking connection status...
        </div>
      ) : null}

      {/* Connected apps */}
      <section>
        {loading ? (
          <div className={styles.connectedGrid}>
            {[1, 2].map((i) => (
              <div key={i} className={styles.skeletonConnected}>
                <div className={`${styles.skeleton} ${styles.skeletonCircle}`} />
                <div className={styles.skeletonCol}>
                  <div className={`${styles.skeleton} ${styles.skeletonLineShort}`} />
                  <div className={`${styles.skeleton} ${styles.skeletonLineTiny}`} />
                </div>
              </div>
            ))}
          </div>
        ) : connectedApps.length === 0 ? (
          <div className={styles.emptyConnected}>
            <div className={styles.emptyConnectedIcon}>
              <Zap size={24} />
            </div>
            <h3 className={styles.emptyConnectedTitle}>No apps connected</h3>
            <p className={styles.emptyConnectedText}>
              Connect apps so Tallei can read, write, and act across your tools.
            </p>
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => setAddOpen(true)}
            >
              <Plus size={16} />
              Add your first app
            </button>
          </div>
        ) : (
          <div className={styles.connectedGrid}>
            {connectedApps.map((account) => {
              const app = account.app;
              const isBusy = busyKey === `disconnect-${account.id}`;
              return (
                <div key={account.id} className={styles.connectedCard}>
                  <div className={styles.connectedCardLeft}>
                    <div className={styles.connectedIconWrap}>
                      <app.icon size={22} />
                    </div>
                    <div className={styles.connectedInfo}>
                      <span className={styles.connectedName}>{app.name}</span>
                      <span className={styles.connectedId}>
                        {account.externalAccountId}
                      </span>
                    </div>
                  </div>
                  <div className={styles.connectedCardRight}>
                    <span className={`${styles.statusPill} ${styles.statusConnected}`}>
                      <CheckCircle2 size={10} />
                      Connected
                    </span>
                    <button
                      type="button"
                      className={styles.disconnectIconBtn}
                      onClick={() => void disconnect(account.id)}
                      disabled={isBusy || busyKey !== null}
                      title="Disconnect"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Recommended */}
      {recommendedApps.length > 0 && !loading && (
        <section className={styles.recommendedSection}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Recommended</h2>
            <p className={styles.sectionSubtitle}>Popular apps to get started</p>
          </div>
          <div className={styles.recommendedGrid}>
            {recommendedApps.map((app) => {
              const isBusy = busyKey === app.key;
              const isComingSoon = app.scopes.length === 0;
              return (
                <div key={app.key} className={styles.recommendedCard}>
                  <div className={styles.recommendedTop}>
                    <div className={styles.recommendedIconWrap}>
                      <app.icon size={22} />
                    </div>
                    <div className={styles.recommendedMeta}>
                      <span className={styles.recommendedName}>{app.name}</span>
                      <span className={styles.recommendedCategory}>{app.category}</span>
                    </div>
                  </div>
                  <p className={styles.recommendedDesc}>{app.description}</p>
                  <div className={styles.recommendedFooter}>
                    {isComingSoon ? (
                      <span className={`${styles.statusPill} ${styles.statusSoon}`}>
                        <Sparkles size={10} />
                        Coming soon
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={styles.connectMiniBtn}
                        onClick={() => void startAuth(app)}
                        disabled={isBusy || busyKey !== null}
                      >
                        {isBusy ? "Connecting..." : "Connect"}
                        <ArrowRight size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Add App Drawer */}
      {addOpen && (
        <AddAppDrawer
          onClose={() => setAddOpen(false)}
          connectedKeys={new Set(connectors.map((c) => resolveConnectorKey(c)).filter((k): k is string => !!k))}
          busyKey={busyKey}
          onConnect={startAuth}
          onDisconnect={(accountId) => void disconnect(accountId)}
          connectors={connectors}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Add App Drawer                                                      */
/* ------------------------------------------------------------------ */
function AddAppDrawer({
  onClose,
  connectedKeys,
  busyKey,
  onConnect,
  onDisconnect,
  connectors,
}: {
  onClose: () => void;
  connectedKeys: Set<string>;
  busyKey: string | null;
  onConnect: (app: AppDef) => void;
  onDisconnect: (accountId: string) => void;
  connectors: ConnectorAccount[];
}) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<AppCategory>("All");

  useKeydown("Escape", onClose);

  const filtered = useMemo(() => {
    let list = APPS;
    if (activeCategory !== "All") list = list.filter((a) => a.category === activeCategory);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.category.toLowerCase().includes(q)
      );
    }
    return list;
  }, [activeCategory, search]);

  const connectedAccountByKey = useMemo(() => {
    const map = new Map<string, ConnectorAccount>();
    for (const c of connectors) {
      const key = resolveConnectorKey(c);
      if (key) map.set(key, c);
    }
    return map;
  }, [connectors]);

  return (
    <div className={styles.drawerOverlay} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <div>
            <h2 className={styles.drawerTitle}>Add integration</h2>
            <p className={styles.drawerSubtitle}>Browse and connect your tools</p>
          </div>
          <button type="button" className={styles.drawerClose} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className={styles.drawerSearchWrap}>
          <Search size={15} className={styles.drawerSearchIcon} />
          <input
            type="text"
            placeholder="Search apps..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={styles.drawerSearchInput}
            autoFocus
          />
          <div className={styles.drawerKbd}>
            <Command size={10} />
            <span>K</span>
          </div>
        </div>

        <div className={styles.drawerTabs}>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCategory(cat)}
              className={`${styles.drawerTab} ${activeCategory === cat ? styles.drawerTabActive : ""}`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className={styles.drawerList}>
          {filtered.length === 0 ? (
            <div className={styles.drawerEmpty}>
              <Search size={32} className={styles.drawerEmptyIcon} />
              <p className={styles.drawerEmptyTitle}>No apps found</p>
              <p className={styles.drawerEmptyText}>Try a different search or category.</p>
            </div>
          ) : (
            filtered.map((app) => {
              const connected = connectedKeys.has(app.key);
              const account = connectedAccountByKey.get(app.key);
              const isBusy = busyKey === app.key || (account && busyKey === `disconnect-${account.id}`);
              const isComingSoon = app.scopes.length === 0;

              return (
                <div key={app.key} className={styles.drawerRow}>
                  <div className={styles.drawerRowLeft}>
                    <div className={styles.drawerRowIcon}>
                      <app.icon size={22} />
                    </div>
                    <div className={styles.drawerRowInfo}>
                      <div className={styles.drawerRowHead}>
                        <span className={styles.drawerRowName}>{app.name}</span>
                        {connected ? (
                          <span className={`${styles.statusPill} ${styles.statusConnected}`}>
                            <CheckCircle2 size={10} />
                            Connected
                          </span>
                        ) : isComingSoon ? (
                          <span className={`${styles.statusPill} ${styles.statusSoon}`}>
                            <Sparkles size={10} />
                            Coming soon
                          </span>
                        ) : null}
                      </div>
                      <p className={styles.drawerRowDesc}>{app.description}</p>
                    </div>
                  </div>
                  <div className={styles.drawerRowRight}>
                    {connected && account ? (
                      <button
                        type="button"
                        className={styles.disconnectIconBtn}
                        onClick={() => onDisconnect(account.id)}
                        disabled={isBusy || busyKey !== null}
                        title="Disconnect"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : isComingSoon ? (
                      <span className={styles.comingSoonLabel}>Coming soon</span>
                    ) : (
                      <button
                        type="button"
                        className={styles.connectMiniBtn}
                        onClick={() => onConnect(app)}
                        disabled={isBusy || busyKey !== null}
                      >
                        {isBusy ? "..." : "Connect"}
                        <ArrowRight size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
