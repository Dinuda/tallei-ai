/** Canonical loop goal for Lenny's weekly newsletter preset (keep in sync with backend preset). */
export const LENNY_NEWSLETTER_LOOP_GOAL =
  "Lenny writes a weekly product newsletter for product builders. Build a recurring loop with Search Agent, Web Search Agent, Research Agent, Writer, and Publicist. Publicist emails the operator for approval, then after approval the operator uploads a contact list and the loop distributes the newsletter via Resend.";

export function isLennyNewsletterGoal(goal: string | undefined): boolean {
  if (!goal?.trim()) return false;
  return /\blenny\b/i.test(goal) && /\bnewsletter\b/i.test(goal);
}

export function isNewsletterLoopDefinition(input: {
  goal?: string;
  presetId?: string;
  title?: string;
}): boolean {
  if (input.presetId === "newsletter" || input.presetId === "newsletter_v1") return true;
  if (input.title === "Newsletter Loop") return true;
  if (isLennyNewsletterGoal(input.goal)) return true;
  return /\bnewsletter\b/i.test(input.goal ?? "");
}
