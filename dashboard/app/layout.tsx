import type { Metadata, Viewport } from "next";
import { auth } from "../auth";
import { Providers } from "./providers";
import { TopNav } from "./top-nav";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const metadataDescription =
  "Tallei syncs persistent memory across ChatGPT, Claude, and Gemini. Write your preferences once — every AI assistant already knows them.";

export const metadata: Metadata = {
  metadataBase: new URL("https://tallei.com"),
  applicationName: "Tallei",
  authors: [{ name: "Tallei", url: "https://tallei.com" }],
  category: "productivity",

  title: {
    default: "Tallei — Sync Memory Between ChatGPT, Claude & Gemini",
    template: "%s | Tallei",
  },
  description: metadataDescription,

  keywords: [
    "sync ChatGPT and Claude memory",
    "shared AI memory",
    "persistent memory for AI assistants",
    "ChatGPT Claude memory bridge",
    "AI memory sync tool",
    "cross-AI context sharing",
    "ChatGPT memory sync",
    "Claude persistent memory",
    "Gemini memory",
    "AI assistant context manager",
    "memory layer for AI",
    "universal AI memory",
    "shared context AI tools",
    "stop repeating yourself to AI",
    "MCP memory protocol",
    "AI workflow tool",
    "ChatGPT Claude Gemini integration",
    "persistent AI preferences",
    "AI context synchronization",
    "AI productivity tool",
    "cross-platform AI memory",
    "AI shared notebook",
  ],

  openGraph: {
    type: "website",
    siteName: "Tallei",
    title: "Tallei — Sync Memory Between ChatGPT, Claude & Gemini",
    description: metadataDescription,
    url: "https://tallei.com",
    locale: "en_US",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Tallei — shared memory layer for ChatGPT, Claude, and Gemini",
        type: "image/png",
      },
    ],
  },

  twitter: {
    card: "summary_large_image",
    site: "@tallei_ai",
    creator: "@tallei_ai",
    title: "Tallei — Sync Memory Between ChatGPT, Claude & Gemini",
    description: metadataDescription,
    images: ["https://tallei.com/opengraph-image"],
  },

  icons: {
    shortcut: "/favicon.ico",
    icon: [{ url: "/icon.png", type: "image/png", sizes: "32x32" }],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },

  manifest: "/manifest.webmanifest",

  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      noimageindex: false,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },

  alternates: {
    canonical: "https://tallei.com",
  },

  verification: {
    google: "REPLACE_WITH_GOOGLE_SEARCH_CONSOLE_TOKEN",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111827" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="en" suppressHydrationWarning className={cn("font-sans", geist.variable)}>
      <body suppressHydrationWarning>
        <Providers session={session}>
          <TopNav />
          {children}
        </Providers>
      </body>
    </html>
  );
}
