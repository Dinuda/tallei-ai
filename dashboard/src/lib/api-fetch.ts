"use client";

const STORAGE_KEY = "tallei.activeWorkspaceId";

let activeWorkspaceId: string | null = null;

export function getStoredWorkspaceId(): string | null {
  if (typeof window === "undefined") return activeWorkspaceId;
  if (activeWorkspaceId) return activeWorkspaceId;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setStoredWorkspaceId(workspaceId: string): void {
  activeWorkspaceId = workspaceId;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, workspaceId);
  }
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const workspaceId = getStoredWorkspaceId();
  const headers = new Headers(init?.headers ?? {});
  if (workspaceId) headers.set("X-Workspace-Id", workspaceId);
  if (!headers.has("content-type") && init?.body) headers.set("content-type", "application/json");
  return fetch(input, { ...init, headers });
}
