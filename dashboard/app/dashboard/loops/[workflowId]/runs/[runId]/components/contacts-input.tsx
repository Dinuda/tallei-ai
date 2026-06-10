"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { EditorialActionButton } from "./glyph-icons";
import type { ContactSourceKind } from "@/lib/loop-run-workspace-projection";

export type ContactRow = {
  email: string;
  name?: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

export function parseContactsClient(text: string): ContactRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstCells = parseCsvLine(lines[0]);
  const headers = firstCells.map((cell) => cell.trim().toLowerCase().replace(/\s+/g, "_"));
  const emailIndex = headers.findIndex((header) => header === "email" || header === "email_address");
  const nameIndex = headers.findIndex((header) => header === "name" || header === "full_name");
  const dataLines = emailIndex >= 0 ? lines.slice(1) : lines;
  const contacts: ContactRow[] = [];
  const seen = new Set<string>();

  for (const line of dataLines) {
    const cells = parseCsvLine(line);
    if (cells.every((cell) => !cell.trim())) continue;
    let email = "";
    let name = "";
    if (emailIndex >= 0) {
      email = (cells[emailIndex] ?? "").trim().toLowerCase();
      name = nameIndex >= 0 ? (cells[nameIndex] ?? "").trim() : "";
    } else if (cells.length === 1) {
      email = cells[0].trim().toLowerCase();
    } else {
      email = cells[0].trim().toLowerCase();
      name = cells[1]?.trim() ?? "";
    }
    if (!EMAIL_PATTERN.test(email) || seen.has(email)) continue;
    seen.add(email);
    contacts.push(name ? { email, name } : { email });
  }
  return contacts;
}

/** Recipient upload — same editorial panel pattern as MissingInputWorkspace. */
export function ContactsInputWorkspace({
  contactSourceKind,
  recipientCount,
  busy,
  onSave,
}: {
  contactSourceKind: ContactSourceKind;
  recipientCount: number;
  busy: boolean;
  onSave: (input: { csvText?: string; contacts?: ContactRow[]; audienceId?: string }) => Promise<void>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"upload" | "paste" | "configured">(
    contactSourceKind === "configured" ? "configured" : contactSourceKind === "operator_input" ? "paste" : "upload",
  );
  const [csvPreview, setCsvPreview] = useState<ContactRow[]>([]);
  const [csvRawText, setCsvRawText] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const pasteContacts = useMemo(() => parseContactsClient(pasteText), [pasteText]);
  const activeCount = tab === "upload"
    ? csvPreview.length
    : tab === "paste"
      ? pasteContacts.length
      : audienceId.trim() ? Math.max(recipientCount, 1) : 0;

  const ingestText = useCallback((text: string) => {
    setLocalError(null);
    const contacts = parseContactsClient(text);
    if (contacts.length === 0) {
      setLocalError("No valid email addresses found.");
      setCsvPreview([]);
      return;
    }
    setCsvPreview(contacts);
    setCsvRawText(text);
  }, []);

  const handleFile = useCallback(async (file: File) => {
    const text = await file.text();
    ingestText(text);
  }, [ingestText]);

  async function handleSave() {
    setLocalError(null);
    try {
      if (tab === "configured") {
        if (!audienceId.trim()) {
          setLocalError("Enter an audience or list ID.");
          return;
        }
        await onSave({ audienceId: audienceId.trim() });
        return;
      }
      const contacts = tab === "upload" ? csvPreview : pasteContacts;
      if (contacts.length === 0) {
        setLocalError(tab === "upload" ? "Upload a CSV with at least one email." : "Paste at least one email address.");
        return;
      }
      await onSave({
        contacts,
        ...(tab === "upload" && csvRawText.trim() ? { csvText: csvRawText } : {}),
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Failed to save contacts.");
    }
  }

  const fieldHint = recipientCount > 0
    ? `${recipientCount} contacts saved to memory — approve send when ready.`
    : "Upload a CSV or paste emails, then save before approving send.";

  return (
    <section className="flex min-h-0 flex-1 flex-col border-b border-[#ebebeb] last:border-b-0">
      <div
        className="group min-h-0 flex-1 overflow-y-auto px-7 py-6"
        style={{ fontFamily: "var(--font-fustat)" }}
      >
<div
          className="-mx-2 rounded-md px-3 py-2 transition-colors hover:bg-[#eef7dc]">
        <p className="mb-3 text-[13px] font-medium text-[#9b9a97]">Recipient list</p>

        <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
          <TabsList className="mb-4 grid w-full grid-cols-3">
            <TabsTrigger value="upload">Upload CSV</TabsTrigger>
            <TabsTrigger value="paste">Paste emails</TabsTrigger>
            {contactSourceKind === "configured" ? (
              <TabsTrigger value="configured">Audience ID</TabsTrigger>
            ) : (
              <TabsTrigger value="configured" disabled>Audience ID</TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="upload" className="mt-0 space-y-3">
            <div
              className={cn(
                "flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-6 text-center transition-colors",
                dragOver ? "border-[#9b9a97] bg-[#f7f7f5]" : "border-[#e5e5e0] bg-transparent hover:border-[#c4c4c0] hover:bg-[#f7f7f5]",
              )}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                const file = event.dataTransfer.files[0];
                if (file) void handleFile(file);
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="mb-2 size-6 text-[#9b9a97]" />
              <p className="text-[14px] text-[#37352f]">Drop CSV or click to browse</p>
              <p className="mt-1 text-[12px] text-[#9b9a97]">email column required, name optional</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
            </div>
            {csvPreview.length > 0 ? (
              <p className="text-[13px] text-[#6b7280]">{csvPreview.length} contacts ready to save</p>
            ) : null}
          </TabsContent>

          <TabsContent value="paste" className="mt-0">
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              placeholder={"one@example.com\nname@company.com, Jane Doe"}
              rows={8}
              className="w-full resize-none border-0 bg-transparent text-[15px] leading-[1.65] text-[#37352f] outline-none placeholder:text-[#c4c4c0] focus:ring-0"
            />
            {pasteContacts.length > 0 ? (
              <p className="mt-2 text-[13px] text-[#9b9a97]">{pasteContacts.length} valid emails detected</p>
            ) : null}
          </TabsContent>

          <TabsContent value="configured" className="mt-0 space-y-2">
            <Input
              value={audienceId}
              onChange={(event) => setAudienceId(event.target.value)}
              placeholder="aud_…"
              className="h-10 border-[#e5e5e0] bg-transparent shadow-none focus-visible:ring-[#c4c4c0]"
            />
            <p className="text-[12px] text-[#9b9a97]">Audience or segment ID from your email provider.</p>
          </TabsContent>
        </Tabs>

        {localError ? (
          <p className="mt-3 text-[13px] text-[#991b1b]">{localError}</p>
        ) : null}
        </div>
      </div>

      <div className="mt-auto shrink-0 border-t border-[#ebebeb] bg-[#fafafa] px-7 py-4">
        <div className="flex items-center justify-between gap-4">
          <p className="min-w-0 text-[13px] text-[#9b9a97]">{fieldHint}</p>
          <div className="flex shrink-0 items-center gap-2">
            {busy ? <Loader2 className="size-4 animate-spin text-[#9b9a97]" /> : null}
            <EditorialActionButton
              label={busy ? "Saving…" : "Save contacts"}
              glyph="submit"
              variant="primary"
              onClick={() => void handleSave()}
              disabled={busy || (tab !== "configured" && activeCount === 0) || (tab === "configured" && !audienceId.trim())}
              className="px-5 text-[14px]"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
