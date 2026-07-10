import type { Metadata } from "next";
import { HomeContent } from "./home-content";

export const metadata: Metadata = {
  title: {
    absolute: "Tallei — Cross-AI Memory",
  },
  description:
    "Tallei remembers your work across ChatGPT, Claude, and Gemini so every AI already knows your context.",
  alternates: {
    canonical: "https://tallei.com",
  },
  openGraph: {
    title: "Tallei — Cross-AI Memory",
    description:
      "Tallei remembers your work across ChatGPT, Claude, and Gemini so every AI already knows your context.",
    url: "https://tallei.com",
    siteName: "Tallei",
  },
};

export default function Page() {
  return <HomeContent />;
}
