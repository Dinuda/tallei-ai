"use client";

import { LoaderCircle } from "lucide-react";

import {
  ChatArtifactScrollFade,
  ChatArtifactToolbar,
} from "@/components/chat-artifact-layout";
import { EmailArtifactCanvas } from "@/components/email-artifact-canvas";
import {
  copyTemplateBundle,
  downloadTemplateHtml,
  featuredTemplate,
} from "@/lib/email-artifacts/export";
import type { EmailArtifactTemplate } from "@/lib/email-artifacts/types";
import { cn } from "@/lib/utils";

export function EmailArtifactPreviewCard({
  approved,
  loading,
  onOpen,
  templates,
}: {
  approved?: boolean;
  loading?: boolean;
  onOpen: () => void;
  templates: EmailArtifactTemplate[];
}) {
  const featured = featuredTemplate(templates);

  return (
    <div
      className={cn(
        "group my-3 w-full overflow-hidden rounded-2xl border border-[#e8e8e8] bg-white text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
        "transition-shadow hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)]",
      )}
    >
      <ChatArtifactToolbar
        editLabel="Edit"
        onCopy={featured ? () => void copyTemplateBundle(templates) : undefined}
        onDownload={featured ? () => downloadTemplateHtml(featured) : undefined}
        onEdit={onOpen}
        onExpand={onOpen}
      />

      <button
        className="relative block w-full text-left"
        onClick={onOpen}
        type="button"
      >
        <div className="max-h-[300px] overflow-hidden px-6 pb-8 pt-5">
          {loading ? (
            <div className="flex h-[180px] items-center justify-center text-[13px] text-[#6b7280]">
              <LoaderCircle className="mr-2 size-4 animate-spin" />
              Drafting reply templates…
            </div>
          ) : featured ? (
            <div className="space-y-4">
              <div>
                <h3
                  className="text-[22px] font-semibold tracking-[-0.02em] text-[#111827]"
                  style={{ fontFamily: "var(--font-title)" }}
                >
                  Reply templates
                </h3>
                <p className="mt-1 text-[13px] text-[#9ca3af]">
                  {approved
                    ? `${templates.length} saved · minimal`
                    : `${templates.length} emails · minimal · click to edit`}
                </p>
              </div>

              <hr className="border-[#ececec]" />

              <div className="flex flex-wrap gap-2">
                {templates.map((template) => (
                  <span
                    className="rounded-full border border-[#e5e5e5] bg-[#fafafa] px-2.5 py-1 text-[11px] font-medium text-[#6b7280]"
                    key={template.id}
                  >
                    {template.name}
                  </span>
                ))}
              </div>

              <p className="text-[15px] font-medium text-[#374151]">{featured.subject}</p>

              <EmailArtifactCanvas
                className="mt-2 rounded-lg border-[#ececec] shadow-none"
                compact
                html={featured.html}
                subject={featured.subject}
              />
            </div>
          ) : (
            <div className="flex h-[180px] items-center justify-center px-4 text-center text-[13px] text-[#9ca3af]">
              Open to review and edit customer-facing reply emails.
            </div>
          )}
        </div>
        {!loading && featured ? <ChatArtifactScrollFade /> : null}
      </button>
    </div>
  );
}
