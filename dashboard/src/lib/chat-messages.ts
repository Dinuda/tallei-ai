import type { UIMessage } from "ai";

/** Keep the first occurrence when useChat or session reload produces duplicate message ids. */
export function dedupeChatMessagesById(messages: UIMessage[]): UIMessage[] {
  const seen = new Set<string>();
  const deduped: UIMessage[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    deduped.push(message);
  }
  return deduped;
}
