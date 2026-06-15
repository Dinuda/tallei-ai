"use client";

import { useEffect } from "react";
import { Check } from "lucide-react";

export default function ConnectorCompletePage() {
  useEffect(() => {
    window.opener?.postMessage({ type: "tallei-connector-complete" }, window.location.origin);
    const timer = window.setTimeout(() => window.close(), 500);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f9f8fc] p-6">
      <div className="border border-[#e8e5f0] bg-white p-8 text-center">
        <span className="mx-auto flex size-12 items-center justify-center bg-emerald-600 text-white"><Check /></span>
        <h1 className="mt-4 text-lg font-semibold">Connection received</h1>
        <p className="mt-1 text-sm text-slate-500">Returning to the loop builder...</p>
      </div>
    </main>
  );
}
