import type { AuthContext } from "../../domain/auth/index.js";
import { contactsToCsv } from "../loop-executor/csv-parser.js";
import type { LoopContactRow } from "../loop-executor/types.js";
import { stashDocument } from "../documents.js";
import type { RuntimeContext } from "./types.js";

type ContactListDocumentRefs = {
  documentRef: string;
  lotRef?: string;
};

export async function stashContactListAsDocument(input: {
  auth: AuthContext;
  contacts: LoopContactRow[];
  csvText?: string;
  titleHint?: string;
  runId?: string;
}): Promise<ContactListDocumentRefs> {
  if (input.contacts.length === 0) {
    throw new Error("Cannot stash an empty contact list as a document.");
  }

  const content = input.csvText?.trim() || contactsToCsv(input.contacts);
  const baseTitle = input.titleHint?.trim() || "Loop contact list";
  const runSuffix = input.runId ? ` · run ${input.runId.slice(0, 8)}` : "";
  const title = `${baseTitle}${runSuffix}`;

  const stashed = await stashDocument(content, input.auth, {
    filename: "contacts.csv",
    title,
    mimeType: "text/csv",
  });

  return {
    documentRef: stashed.refHandle,
    ...(stashed.lotRef ? { lotRef: stashed.lotRef } : {}),
  };
}

export type DeliveryRecipients = NonNullable<RuntimeContext["deliveryRecipients"]>;

export function buildDeliveryRecipientsPatch(input: {
  contacts: LoopContactRow[];
  source?: "uploaded" | "configured" | "operator_input";
  audienceId?: string;
  documentRef?: string;
  lotRef?: string;
}): DeliveryRecipients {
  const recipientCount = input.contacts.length > 0
    ? input.contacts.length
    : input.audienceId?.trim()
      ? 1
      : 0;
  return {
    uploadedAt: new Date().toISOString(),
    contacts: input.contacts,
    recipientCount,
    ...(input.source ? { source: input.source } : {}),
    ...(input.audienceId ? { audienceId: input.audienceId } : {}),
    ...(input.documentRef ? { documentRef: input.documentRef } : {}),
    ...(input.lotRef ? { lotRef: input.lotRef } : {}),
  };
}

export function contactsFromDecision(decision: Record<string, unknown>): LoopContactRow[] {
  if (!Array.isArray(decision.contacts)) return [];
  const contacts: LoopContactRow[] = [];
  for (const row of decision.contacts) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const email = typeof item.email === "string"
      ? item.email.trim()
      : "";
    if (!email.includes("@")) continue;
    const name = typeof item.name === "string"
      ? item.name.trim()
      : undefined;
    contacts.push({ email, ...(name ? { name } : {}) });
  }
  return contacts;
}
