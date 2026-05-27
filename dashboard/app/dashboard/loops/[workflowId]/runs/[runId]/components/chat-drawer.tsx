"use client";

import { Send, X } from "lucide-react";
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
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  comments: ChatComment[];
  message: string;
  setMessage: (v: string) => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      direction="right"
    >
      <DrawerContent className="flex h-full flex-col rounded-l-xl border-l bg-background shadow-2xl sm:max-w-[420px]">
        {/* Vaul handle — visible on bottom drawers, hide here */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <DrawerTitle className="text-sm font-semibold">Steer the run</DrawerTitle>
          <DrawerClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close">
              <X className="size-4" />
            </Button>
          </DrawerClose>
        </div>

        {/* Quick suggestions */}
        <div className="flex flex-wrap gap-1.5 border-b px-4 py-3">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setMessage(s)}
              className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-muted hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>

        {/* Thread */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 px-4 py-4">
            {comments.length > 0 ? (
              comments.map((c) => {
                const isUser = c.author === "user";
                return (
                  <article key={c.id} className={`space-y-1 ${isUser ? "items-end" : ""} flex flex-col`}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium capitalize">
                        {c.author === "ceo" ? "CEO" : c.author.replace(/_/g, " ")}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{age(c.createdAt)}</span>
                    </div>
                    <div
                      className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 text-sm leading-5 ${
                        isUser
                          ? "rounded-tr-sm bg-primary text-primary-foreground"
                          : "rounded-tl-sm bg-muted/60 text-foreground"
                      }`}
                    >
                      <Streamdown>{c.body}</Streamdown>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="py-10 text-center">
                <p className="text-sm font-medium text-muted-foreground">No messages yet</p>
                <p className="mt-1 text-xs text-muted-foreground/70">Pick a suggestion or write your own below.</p>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Input */}
        <div className="border-t p-4">
          <InputGroup className="h-auto flex-col items-stretch">
            <InputGroupTextarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Ask the CEO to change direction…"
              className="min-h-20 resize-none"
            />
            <InputGroupAddon align="block-end" className="justify-between border-t">
              <span className="text-xs text-muted-foreground">Preview only — send not yet wired</span>
              <InputGroupButton disabled type="button" size="icon-sm" aria-label="Send">
                <Send className="size-3.5" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
