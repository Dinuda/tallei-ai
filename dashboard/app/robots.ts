import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/dashboard/", "/authorize/"],
      },
    ],
    sitemap: "https://tallei.com/sitemap.xml",
    host: "https://tallei.com",
  };
}
