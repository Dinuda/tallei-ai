import type { Metadata } from "next";
import { HomeContent } from "./home-content";

export const metadata: Metadata = {
  title: {
    absolute: "Tallei — Agent Loops That Remember You",
  },
  alternates: {
    canonical: "https://tallei.com",
  },
};

export default function Page() {
  return <HomeContent />;
}
