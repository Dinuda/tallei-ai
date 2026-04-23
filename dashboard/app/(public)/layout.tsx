import type { ReactNode } from "react";
import { TopNav } from "./top-nav";
import "./public-theme.css";

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="public-root">
      <TopNav />
      {children}
    </div>
  );
}
