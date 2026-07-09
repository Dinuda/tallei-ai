import type { Metadata } from "next";
import { HomeContentLoops } from "./home-content-loops";

export const metadata: Metadata = {
  title: {
    absolute: "Tallei — Your repeated work should run itself",
  },
  description:
    "Tallei turns recurring tasks across ChatGPT, Claude, Gmail, Docs, Slack, and Notion into specialized AI Loops — workflows powered by focused agents that research, write, format, and deliver.",
  alternates: {
    canonical: "https://tallei.com",
  },
  openGraph: {
    title: "Tallei — Your repeated work should run itself",
    description:
      "Tallei turns recurring tasks into specialized AI Loops powered by focused agents — with approval-first control.",
    url: "https://tallei.com",
    siteName: "Tallei",
  },
};

export default function Page() {
  return <HomeContentLoops />;
}
