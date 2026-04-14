import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tallei — AI Memory Sync",
    short_name: "Tallei",
    description:
      "Sync persistent memory across ChatGPT, Claude, and Gemini.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#111827",
    categories: ["productivity", "utilities"],
    icons: [
      {
        src: "/tallei.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
