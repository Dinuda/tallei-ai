/** Canonical loop goal for Lenny's weekly newsletter preset. */
export const LENNY_NEWSLETTER_LOOP_GOAL =
  "Lenny writes a weekly product newsletter for product builders. Build a recurring loop with Search Agent, Web Search Agent, Research Agent, Writer, and Publicist. Publicist emails the operator for approval, then after approval the operator uploads a contact list and the loop distributes the newsletter via Resend.";

export function isLennyNewsletterGoal(goal: string | undefined): boolean {
  if (!goal?.trim()) return false;
  return /\blenny\b/i.test(goal) && /\bnewsletter\b/i.test(goal);
}
