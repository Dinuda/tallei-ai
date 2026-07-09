"use client";

import type { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { createContext, useContext } from "react";

import type { ChatStatus } from "@/components/conductor/conductor-shared";
import type { BuilderLiveUsage } from "@/lib/loop-builder-usage";

export type ConductorChatApi = {
  sendMessage: (input?: { text?: string }) => void;
  addToolOutput: (params: {
    tool: string;
    toolCallId: string;
    output: unknown;
  }) => Promise<void>;
  regenerate: ReturnType<typeof useChat>["regenerate"];
  stop: ReturnType<typeof useChat>["stop"];
};

export type ConductorChatContextValue = {
  messages: UIMessage[];
  chatStatus: ChatStatus;
  chatApi: ConductorChatApi;
  chatUsage: BuilderLiveUsage;
  chatError: string | null;
  /** Tool calls answered locally before useChat / server state catches up. */
  optimisticallyResolvedToolCallIds: ReadonlySet<string>;
};

const ConductorChatContext = createContext<ConductorChatContextValue | null>(null);

export function ConductorChatProvider({
  value,
  children,
}: {
  value: ConductorChatContextValue;
  children: React.ReactNode;
}) {
  return (
    <ConductorChatContext.Provider value={value}>
      {children}
    </ConductorChatContext.Provider>
  );
}

export function useConductorChat(): ConductorChatContextValue | null {
  return useContext(ConductorChatContext);
}
