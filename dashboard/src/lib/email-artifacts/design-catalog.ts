import type { EmailDesignId } from "./types";

export type EmailDesignDefinition = {
  id: EmailDesignId;
  name: string;
  description: string;
  source: string;
  accent: string;
  preview: {
    background: string;
    card: string;
    text: string;
    accent: string;
  };
};

export const EMAIL_DESIGN_CATALOG: EmailDesignDefinition[] = [
  {
    id: "minimal",
    name: "Minimal",
    description: "Clean support reply with a soft accent border.",
    source: "React Email · Starter",
    accent: "#7eb71b",
    preview: { background: "#f8fdf2", card: "#ffffff", text: "#182506", accent: "#7eb71b" },
  },
  {
    id: "vercel-invite",
    name: "Vercel Invite",
    description: "Dark header band with a centered invitation card.",
    source: "react-email/create-email · vercel-invite-user",
    accent: "#000000",
    preview: { background: "#fafafa", card: "#ffffff", text: "#111827", accent: "#000000" },
  },
  {
    id: "stripe-receipt",
    name: "Stripe Receipt",
    description: "Structured receipt-style layout with clear sections.",
    source: "react-email/create-email · stripe-welcome",
    accent: "#635bff",
    preview: { background: "#f6f9fc", card: "#ffffff", text: "#32325d", accent: "#635bff" },
  },
  {
    id: "notion-magic-link",
    name: "Notion Magic Link",
    description: "Simple centered message with a subtle divider.",
    source: "react-email/create-email · notion-magic-link",
    accent: "#111827",
    preview: { background: "#ffffff", card: "#ffffff", text: "#37352f", accent: "#2383e2" },
  },
  {
    id: "linear-welcome",
    name: "Linear Welcome",
    description: "Modern product welcome with bold headline.",
    source: "React Email · Community / Linear",
    accent: "#5e6ad2",
    preview: { background: "#f7f8f8", card: "#ffffff", text: "#1b1b1b", accent: "#5e6ad2" },
  },
  {
    id: "apple-receipt",
    name: "Apple Receipt",
    description: "Refined grayscale receipt with generous spacing.",
    source: "React Email · Community / Apple",
    accent: "#0071e3",
    preview: { background: "#f5f5f7", card: "#ffffff", text: "#1d1d1f", accent: "#0071e3" },
  },
];

export function designById(id: EmailDesignId): EmailDesignDefinition {
  return EMAIL_DESIGN_CATALOG.find((entry) => entry.id === id) ?? EMAIL_DESIGN_CATALOG[0]!;
}
