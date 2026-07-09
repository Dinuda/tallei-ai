import type { ChatMessage, ChatRole } from "../../providers/ai/types.js";
import type { AppContentPart, AppModelMessage } from "../types.js";

export function appMessageContentToText(content: string | AppContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<AppContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function toChatRole(role: AppModelMessage["role"]): ChatRole | null {
  if (role === "system" || role === "user" || role === "assistant") return role;
  return null;
}

export function toLegacyChatMessages(messages: readonly AppModelMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    const role = toChatRole(message.role);
    if (!role) return [];
    return [{
      role,
      content: appMessageContentToText(message.content),
    }];
  });
}

export function toResponsesInput(messages: readonly AppModelMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role === "tool" ? "user" : message.role,
    content: appMessageContentToText(message.content),
  }));
}
