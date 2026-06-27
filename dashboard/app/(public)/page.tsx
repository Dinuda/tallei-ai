import type { Metadata } from "next";
import { HomeContentLoops } from "./home-content-loops";

export const metadata: Metadata = {
  title: {
    absolute: "Tallei — Turn Repeated AI Work Into Loops",
  },
  description:
    "Tallei remembers your scattered AI work, discovers repeated loops, and turns them into approved recurring workflows.",
  alternates: {
    canonical: "https://tallei.com",
  },
  openGraph: {
    title: "Tallei — Turn Repeated AI Work Into Loops",
    description:
      "Tallei remembers your scattered AI work, discovers repeated loops, and turns them into approved recurring workflows.",
    url: "https://tallei.com",
    siteName: "Tallei",
  },
};

export default function Page() {
  return <HomeContentLoops />;
}
