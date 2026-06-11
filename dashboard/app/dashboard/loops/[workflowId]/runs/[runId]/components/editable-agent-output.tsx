"use client";

import { useEffect, useState } from "react";
import { PenLine, Save } from "lucide-react";
import { Streamdown } from "streamdown";

export function EditableAgentOutput({
  text,
  saving,
  onSave,
  forceEditing = false,
}: {
  text: string;
  saving: boolean;
  onSave: (text: string) => Promise<void>;
  forceEditing?: boolean;
}) {
  const [editing, setEditing] = useState(forceEditing);
  const [value, setValue] = useState(text);

  useEffect(() => setValue(text), [text]);
  useEffect(() => {
    if (forceEditing) setEditing(true);
  }, [forceEditing]);

  if (editing) {
    return (
      <div className="flex min-h-[520px] flex-col">
        <textarea
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="min-h-[480px] flex-1 resize-y border border-[#d1d5db] bg-white p-5 font-mono text-[14px] leading-6 text-[#111827] outline-none focus:ring-2 focus:ring-[#2563eb]/20"
        />
        <div className="mt-3 flex justify-end gap-2">
          {!forceEditing ? (
            <button type="button" onClick={() => { setValue(text); setEditing(false); }} className="border border-[#d1d5db] px-4 py-2 text-sm font-semibold">
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            disabled={saving || !value.trim()}
            onClick={async () => { await onSave(value); if (!forceEditing) setEditing(false); }}
            className="inline-flex items-center gap-2 bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            <Save className="size-4" /> Save result
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-2 border border-[#d1d5db] px-4 py-2 text-sm font-semibold hover:bg-[#fafafa]">
          <PenLine className="size-4" /> Edit result
        </button>
      </div>
      <div className="prose prose-slate max-w-none text-[16px] leading-7">
        <Streamdown>{text}</Streamdown>
      </div>
    </div>
  );
}
