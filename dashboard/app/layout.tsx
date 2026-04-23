import type { Metadata, Viewport } from "next";
import { auth } from "../auth";
import { Providers } from "./providers";
import "./globals.css";
import { Fustat, Geist, Space_Grotesk } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-title", weight: ["500", "600", "700"] });
const fustat = Fustat({ subsets: ["latin"], variable: "--font-fustat", weight: ["400", "500", "600", "700"] });

const metadataDescription =
  "Tired of repeating yourself to every AI? Tallei syncs persistent memory across ChatGPT, Claude, and Gemini. Write your preferences once — every AI assistant already knows them.";

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
    // brand
    "tallei",
    "tallei ai",
    "tallei memory",
    "tallei mcp",
    // problem-aware: frustration searches
    "AI forgets my preferences",
    "AI doesn't remember context",
    "how to make AI remember me",
    "why does ChatGPT keep forgetting",
    "keep AI memory across sessions",
    "AI memory across sessions",
    "stop repeating yourself to AI",
    "AI forgets context every conversation",
    // solution-aware searches
    "sync AI memory between tools",
    "shared AI memory",
    "persistent memory for AI assistants",
    "AI memory sync tool",
    "cross-AI context sharing",
    "memory layer for AI assistants",
    "universal AI memory",
    "AI assistant memory manager",
    // platform-specific
    "ChatGPT memory sync",
    "ChatGPT and Claude memory bridge",
    "sync ChatGPT and Claude memory",
    "Claude persistent memory",
    "Gemini memory sync",
    "ChatGPT Claude Gemini integration",
    // technical / developer
    "MCP memory protocol",
    "MCP server memory",
    "Claude MCP memory tool",
    "AI memory API",
    // general
    "AI productivity tool",
    "persistent AI preferences",
    "AI context synchronization",
    "cross-platform AI memory",
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
    shortcut: "/icon",
    icon: [{ url: "/icon", type: "image/png", sizes: "32x32" }],
    apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }],
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

  // verification: { google: "ADD_GOOGLE_SEARCH_CONSOLE_TOKEN_HERE" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fdf2" },
    { media: "(prefers-color-scheme: dark)", color: "#182506" },
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
    <html lang="en" suppressHydrationWarning className={cn("font-sans", geist.variable, spaceGrotesk.variable, fustat.variable)}>
      <body suppressHydrationWarning>
        <Providers session={session}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
