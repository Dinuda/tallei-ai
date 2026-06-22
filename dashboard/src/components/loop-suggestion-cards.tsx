"use client";

import { motion } from "motion/react";

export type LoopSuggestion = {
  id: string;
  title: string;
  description: string;
  prompt: string;
  image: string;
};

const SUGGESTIONS: LoopSuggestion[] = [
  {
    id: "newsletter",
    title: "Newsletter Loop",
    description: "Curate AI news and send weekly newsletters to subscribers.",
    prompt: "Create a newsletter loop that curates the latest AI news every week and sends it to my subscribers.",
    image: "/loops/newsletter-hub.png",
  },
  {
    id: "lead-scoring",
  title: "Lead Scoring Loop",
    description: "Score incoming leads and notify the sales team when a hot lead arrives.",
    prompt: "Build a loop that scores incoming leads from form submissions and alerts me when a hot lead is identified.",
    image: "/loops/lead-scoring-funnel.png",
  },
  {
    id: "support",
    title: "Support Auto-Reply",
    description: "Auto-classify support tickets and send context-aware replies.",
    prompt: "Set up a loop that monitors support tickets, classifies them by priority, and drafts personalized replies and sends them to the customer.",
    image: "/loops/support-brain.png",
  },
  {
    id: "alerts",
    title: "Smart Alerts",
    description: "Monitor data and notify the right channel when thresholds break.",
    prompt: "Create a loop that monitors my metrics and sends alerts to Slack when thresholds are exceeded.",
    image: "/loops/smart-alerts.png",
  },
  {
    id: "research",
    title: "Research Digest",
    description: "Search the web, summarize findings, and deliver a daily digest.",
    prompt: "Build a loop that searches for the latest trends in my industry and sends me a daily digest.",
    image: "/loops/research-printer.png",
  },
  {
    id: "sync",
    title: "CRM Sync",
    description: "Keep contacts in sync between Notion, Airtable, and your CRM.",
    prompt: "Create a loop that syncs contacts between my Notion database and CRM every day.",
    image: "/loops/crm-sync.png",
  },
];

export function LoopSuggestionCards({
  onSelect,
  className,
}: {
  onSelect: (prompt: string) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <motion.div
        className="mb-8 text-center"
        initial={{ opacity: 0, y: 12 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        animate={{ opacity: 1, y: 0 }}
      >
        <h2 className="text-xl font-semibold text-[#1e1b4b]">
          What would you like to automate?
        </h2>
        <p className="mt-1.5 text-sm text-[#8a86a0]">
          Pick a starter loop or describe your own idea.
        </p>
      </motion.div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SUGGESTIONS.map((suggestion, index) => (
          <motion.button
            key={suggestion.id}
            className="group relative overflow-hidden rounded-2xl border border-[#e8e5f0] text-left transition-shadow hover:shadow-md"
            style={{
              backgroundColor: "#ffffff",
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Ccircle cx='4' cy='4' r='0.7' fill='%235b7aae' opacity='0.06'/%3E%3Ccircle cx='20' cy='10' r='0.5' fill='%235b7aae' opacity='0.04'/%3E%3Ccircle cx='8' cy='22' r='0.6' fill='%235b7aae' opacity='0.05'/%3E%3Ccircle cx='28' cy='18' r='0.5' fill='%235b7aae' opacity='0.04'/%3E%3Ccircle cx='14' cy='28' r='0.8' fill='%235b7aae' opacity='0.05'/%3E%3C/svg%3E")`,
            }}
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
              duration: 0.4,
              delay: index * 0.08,
              ease: [0.16, 1, 0.3, 1],
            }}
            whileHover={{ scale: 1.02, y: -2 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onSelect(suggestion.prompt)}
            type="button"
          >
            {/* Image */}
            <div className="relative w-full aspect-square bg-[#f8fafc] overflow-hidden">
              <img
                src={suggestion.image}
                alt={suggestion.title}
                className="w-full h-full object-cover"
                draggable={false}
              />
              {/* Subtle bottom fade into content */}
              <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-white to-transparent" />
            </div>

            {/* Text */}
            <div className="p-4 pt-0">
              <h3 className="text-sm font-semibold text-[#1e1b4b]">
                {suggestion.title}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-[#8a86a0]">
                {suggestion.description}
              </p>
            </div>

            {/* Hover arrow */}
            <div className="absolute bottom-4 right-4 opacity-0 transition-opacity group-hover:opacity-100">
              <svg
                className="size-4 text-[#d1cfd8]"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
