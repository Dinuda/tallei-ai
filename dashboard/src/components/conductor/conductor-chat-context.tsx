"use client";

import type { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { createContext, useContext } from "react";

import type { ChatStatus } from "@/components/conductor/conductor-shared";

export type ConductorChatApi = {
  sendMessage: (input: { text: string }) => void;
  addToolOutput: ReturnType<typeof useChat>["addToolOutput"];
  regenerate: ReturnType<typeof useChat>["regenerate"];
  stop: ReturnType<typeof useChat>["stop"];
};

export type ConductorChatContextValue = {
  messages: UIMessage[];
  chatStatus: ChatStatus;
  chatApi: ConductorChatApi;
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
