"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { apiFetch, getStoredWorkspaceId, setStoredWorkspaceId } from "@/lib/api-fetch";

export type Workspace = {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  kind: "personal" | "custom";
  isDefault: boolean;
  icon: string | null;
  color: string | null;
};

type WorkspaceContextValue = {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  loading: boolean;
  refresh: (options?: { preferredWorkspaceId?: string | null }) => Promise<void>;
  setActiveWorkspace: (workspaceId: string) => Promise<void>;
  createWorkspace: (input: { name: string; description?: string | null; icon?: string | null; color?: string | null }) => Promise<Workspace>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(getStoredWorkspaceId());
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (options?: { preferredWorkspaceId?: string | null }) => {
    const response = await apiFetch("/api/workspaces", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? "Failed to load workspaces");
    const next = Array.isArray(payload.workspaces) ? payload.workspaces as Workspace[] : [];
    setWorkspaces(next);

    const candidates = [
      options?.preferredWorkspaceId,
      getStoredWorkspaceId(),
      typeof payload.activeWorkspaceId === "string" ? payload.activeWorkspaceId : null,
      next.find((workspace) => workspace.isDefault)?.id ?? null,
      next[0]?.id ?? null,
    ];
    const preferred = candidates.find((id) => id && next.some((workspace) => workspace.id === id)) ?? null;
    if (preferred) {
      setActiveWorkspaceId(preferred);
      setStoredWorkspaceId(preferred);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setLoading(false));
  }, [refresh]);

  const setActiveWorkspace = useCallback(async (workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    setStoredWorkspaceId(workspaceId);
    const response = await apiFetch(`/api/workspaces/${workspaceId}/activate`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? "Failed to activate workspace");
    await refresh({ preferredWorkspaceId: workspaceId });
  }, [refresh]);

  const createWorkspace = useCallback(async (input: { name: string; description?: string | null; icon?: string | null; color?: string | null }) => {
    const response = await apiFetch("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? "Failed to create workspace");
    const workspace = payload.workspace as Workspace;
    await setActiveWorkspace(workspace.id);
    return workspace;
  }, [setActiveWorkspace]);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  const value = useMemo(() => ({
    workspaces,
    activeWorkspace,
    loading,
    refresh,
    setActiveWorkspace,
    createWorkspace,
  }), [workspaces, activeWorkspace, loading, refresh, setActiveWorkspace, createWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return context;
}
