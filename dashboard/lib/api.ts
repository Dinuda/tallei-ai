const FALLBACK_API_BASE = "http://localhost:3000";

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || FALLBACK_API_BASE).replace(/\/$/, "");

export function apiUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export function mcpServerUrl(): string {
  return apiUrl("/mcp");
}
