/**
 * input-gate-handler-registrations.ts — Built-in input gate parsers.
 */

import { parseContactListCsv } from "./csv-parser.js";
import { registerInputGateHandler } from "./input-gate-handlers.js";

registerInputGateHandler("text", ({ value }) => ({
  body: value,
  data: { value },
}));

registerInputGateHandler("input", ({ value }) => ({
  body: value,
  data: { value },
}));

registerInputGateHandler("csv", ({ value }) => {
  const contacts = parseContactListCsv(value);
  return {
    body: `Uploaded ${contacts.length} recipients.`,
    data: { contacts, recipientCount: contacts.length },
    response: { recipientCount: contacts.length },
  };
});

registerInputGateHandler("json", ({ value }) => {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return {
    body: JSON.stringify(parsed, null, 2),
    data: { value: parsed },
  };
});
