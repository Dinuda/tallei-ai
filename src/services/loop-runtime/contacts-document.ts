import type { AuthContext } from "../../domain/auth/index.js";
import { contactsToCsv } from "../loop-executor/csv-parser.js";
import type { LoopContactRow } from "../loop-executor/types.js";
import { stashDocument } from "../documents.js";

export type ContactListDocumentRefs = {
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
