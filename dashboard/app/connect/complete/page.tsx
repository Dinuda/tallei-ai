"use client";

import { useEffect } from "react";
import { Check } from "lucide-react";

const CONNECTOR_RETURN_URL_KEY = "tallei.connectorReturnUrl";

export default function ConnectorCompletePage() {
  useEffect(() => {
    const storedReturnUrl = window.sessionStorage.getItem(CONNECTOR_RETURN_URL_KEY);
    window.sessionStorage.removeItem(CONNECTOR_RETURN_URL_KEY);
    let returnUrl = `${window.location.origin}/dashboard`;
    if (storedReturnUrl) {
      try {
        const candidate = new URL(storedReturnUrl);
        if (candidate.origin === window.location.origin) returnUrl = candidate.toString();
      } catch {
        // Use the safe dashboard fallback.
      }
    }
    const timer = window.setTimeout(() => window.location.replace(returnUrl), 500);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f9f8fc] p-6">
      <div className="border border-[#e8e5f0] bg-white p-8 text-center">
        <span className="mx-auto flex size-12 items-center justify-center bg-emerald-600 text-white"><Check /></span>
        <h1 className="mt-4 text-lg font-semibold">Connection received</h1>
        <p className="mt-1 text-sm text-slate-500">Returning to Conductor...</p>
      </div>
    </main>
  );
}
