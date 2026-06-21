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

/** Prefer server messages for shared ids; keep client-only trailing messages. */
export function mergeChatMessagesById(server: UIMessage[], client: UIMessage[]): UIMessage[] {
  const serverIds = new Set(server.map((message) => message.id));
  const trailingClient = client.filter((message) => !serverIds.has(message.id));
  return dedupeChatMessagesById([...server, ...trailingClient]);
}
