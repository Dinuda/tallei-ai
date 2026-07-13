"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export function EmailArtifactCanvas({
  html,
  subject,
  className,
  compact,
  onClick,
  editable,
}: {
  html: string;
  subject: string;
  className?: string;
  compact?: boolean;
  onClick?: () => void;
  editable?: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(compact ? 108 : 420);

  const srcDoc = useMemo(() => {
    const safeSubject = subject.replace(/</g, "&lt;");
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${safeSubject}</title><style>html,body{margin:0;padding:0;background:#f3f4f6;}body{display:flex;justify-content:center;padding:16px;}</style></head><body>${html}</body></html>`;
  }, [html, subject]);

  useEffect(() => {
    if (compact) {
      setHeight(108);
    }
  }, [compact]);

  useEffect(() => {
    if (compact) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "email-canvas-height") return;
      if (typeof event.data.height !== "number" || event.data.height <= 0) return;
      const next = Math.min(Math.max(event.data.height + 24, 320), 720);
      setHeight((prev) => (Math.abs(next - prev) > 6 ? next : prev));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [compact]);

  const reportHeight = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    const win = iframe?.contentWindow;
    if (!doc || !win) return;
    const nextHeight = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
    win.parent.postMessage({ type: "email-canvas-height", height: nextHeight }, "*");
  }, []);

  return (
    <div
      className={cn(
        "relative overflow-hidden border border-[#e5e7eb] bg-[#f3f4f6]",
        editable && onClick && "cursor-pointer ring-offset-2 hover:ring-2 hover:ring-[#111827]/20",
        className,
      )}
      onClick={editable ? onClick : undefined}
      onKeyDown={editable && onClick ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      } : undefined}
      role={editable && onClick ? "button" : undefined}
      tabIndex={editable && onClick ? 0 : undefined}
      title={editable ? "Click to edit this email" : undefined}
    >
      <iframe
        className="w-full bg-[#f3f4f6]"
        onLoad={() => {
          if (!compact) reportHeight();
        }}
        ref={iframeRef}
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        style={{ height, border: 0 }}
        title={`Email preview: ${subject}`}
      />
    </div>
  );
}
