import type { Metadata } from "next";
import { Providers } from "./providers";
import { TopNav } from "./top-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tallei - Cross-AI Ghost Memory",
  description: "The persistent memory layer that bridges Claude and ChatGPT",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>
          <TopNav />
          {children}
        </Providers>
      </body>
    </html>
  );
}
