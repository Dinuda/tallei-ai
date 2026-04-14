import type { Metadata } from "next";
import { HomeContent } from "./home-content";

export const metadata: Metadata = {
  title: {
    absolute: "Tallei — Sync Memory Between ChatGPT, Claude & Gemini",
  },
  alternates: {
    canonical: "https://tallei.com",
  },
};

export default function Page() {
  return <HomeContent />;
}
