type ApiErrorBody = {
  error?: string;
  details?: Array<{ message?: string; path?: Array<string | number> }>;
};

export function formatApiError(data: ApiErrorBody, fallback: string): string {
  const issueMessage = data.details?.find((detail) => detail.message)?.message;
  if (issueMessage) {
    if (/at most 4000|too long|too big/i.test(issueMessage)) {
      return "Message is too long. Please keep it under 4,000 characters.";
    }
    return issueMessage;
  }
  if (typeof data.error === "string" && data.error !== "Validation failed") {
    return data.error;
  }
  return fallback;
}
