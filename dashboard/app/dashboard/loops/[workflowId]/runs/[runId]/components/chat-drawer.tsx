"use client";

import { useState } from "react";
import { Loader2, Send, Sparkles, X } from "lucide-react";
import { Streamdown } from "streamdown";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";

export type ChatComment = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
};

const SUGGESTIONS = [
  "Make this more customer-focused.",
  "Show sources before drafting.",
  "Shorten the final newsletter.",
  "Add a clear call to action.",
];

function age(iso: string) {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

export function ChatDrawer({
  open,
  onOpenChange,
  comments,
  message,
  setMessage,
  onSend,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  comments: ChatComment[];
  message: string;
  setMessage: (v: string) => void;
  onSend: (body: string) => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  async function handleSend() {
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend(trimmed);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="flex h-full flex-col rounded-l-2xl border-0  shadow-2xl sm:max-w-[420px]">
        <div className="flex items-center justify-between bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-[#7eb71b] text-white">
              <Sparkles className="size-4" />
            </span>
            <DrawerTitle className="text-sm font-semibold text-[#182506]">Steer the run</DrawerTitle>
          </div>
          <DrawerClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close" className="text-[#7a9a4a]">
              <X className="size-4" />
            </Button>
          </DrawerClose>
        </div>

        <div className="flex flex-wrap gap-1.5 bg-white px-4 py-3 shadow-sm">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setMessage(s)}
              className="rounded-full bg-[#e6f5c8] px-2.5 py-1 text-[11px] font-medium text-[#3d5c18] transition-colors hover:bg-[#cde99a]"
            >
              {s}
            </button>
          ))}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 px-4 py-4">
            {comments.length > 0 ? (
              comments.map((c) => {
                const isUser = c.author === "user";
                return (
                  <article key={c.id} className={`flex flex-col space-y-1 ${isUser ? "items-end" : ""}`}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-semibold capitalize text-[#3d5c18]">
                        {c.author === "ceo" ? "CEO" : c.author.replace(/_/g, " ")}
                      </span>
                      <span className="text-[10px] text-[#7a9a4a]">{age(c.createdAt)}</span>
                    </div>
                    <div
                      className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 text-sm leading-5 shadow-sm ${
                        isUser
                          ? "rounded-tr-sm bg-[#7eb71b] text-white"
                          : "rounded-tl-sm bg-white text-[#182506]"
                      }`}
                    >
                      <Streamdown>{c.body}</Streamdown>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="rounded-xl bg-white py-10 text-center shadow-sm">
                <p className="text-sm font-medium text-[#3d5c18]">No messages yet</p>
                <p className="mt-1 text-xs text-[#7a9a4a]">Pick a suggestion or write your own below.</p>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="bg-white p-4 shadow-[0_-4px_20px_rgba(126,183,27,0.08)]">
          {sendError ? (
            <p className="mb-2 text-xs text-rose-600">{sendError}</p>
          ) : null}
          <InputGroup className="h-auto flex-col items-stretch overflow-hidden rounded-xl ring-1 /80">
            <InputGroupTextarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Ask the CEO to change direction…"
              className="min-h-20 resize-none border-0 /50"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
            />
            <InputGroupAddon align="block-end" className="justify-between bg-white px-3 py-2">
              <span className="text-xs text-[#7a9a4a]">Steer this run</span>
              <InputGroupButton
                disabled={sending || !message.trim()}
                type="button"
                size="icon-sm"
                aria-label="Send"
                className="bg-[#7eb71b] text-white hover:bg-[#6aa015]"
                onClick={() => void handleSend()}
              >
                {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
