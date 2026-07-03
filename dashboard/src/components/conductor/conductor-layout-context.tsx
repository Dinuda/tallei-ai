"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ConductorLayoutMeta = {
  loopId?: string;
  loopName?: string;
  status: string;
};

type ConductorLayoutHandlers = {
  onLoopNameChange?: (name: string) => void;
};

type ConductorLayoutContextValue = ConductorLayoutMeta & {
  setLoopMeta: (meta: Partial<ConductorLayoutMeta>) => void;
  resetLoopMeta: () => void;
  commitLoopName: (name: string) => void;
  registerHandlers: (handlers: ConductorLayoutHandlers) => void;
};

const ConductorLayoutContext = createContext<ConductorLayoutContextValue | null>(null);

function mergeLoopMeta(
  prev: ConductorLayoutMeta,
  patch: Partial<ConductorLayoutMeta>,
): ConductorLayoutMeta {
  const next: ConductorLayoutMeta = { ...prev };
  let changed = false;

  if (patch.loopId !== undefined && patch.loopId !== prev.loopId) {
    next.loopId = patch.loopId;
    changed = true;
  }
  if (patch.loopName !== undefined && patch.loopName !== prev.loopName) {
    next.loopName = patch.loopName;
    changed = true;
  }
  if (patch.status !== undefined && patch.status !== prev.status) {
    next.status = patch.status;
    changed = true;
  }

  return changed ? next : prev;
}

export function ConductorLayoutProvider({ children }: { children: ReactNode }) {
  const [meta, setMetaState] = useState<ConductorLayoutMeta>({ status: "draft" });
  const handlersRef = useRef<ConductorLayoutHandlers>({});

  const setLoopMeta = useCallback((patch: Partial<ConductorLayoutMeta>) => {
    setMetaState((prev) => mergeLoopMeta(prev, patch));
  }, []);

  const registerHandlers = useCallback((handlers: ConductorLayoutHandlers) => {
    handlersRef.current = handlers;
  }, []);

  const resetLoopMeta = useCallback(() => {
    setMetaState({ status: "draft" });
  }, []);

  const commitLoopName = useCallback((name: string) => {
    setMetaState((prev) => mergeLoopMeta(prev, { loopName: name }));
    handlersRef.current.onLoopNameChange?.(name);
  }, []);

  const value = useMemo(
    () => ({ ...meta, setLoopMeta, resetLoopMeta, commitLoopName, registerHandlers }),
    [meta, setLoopMeta, resetLoopMeta, commitLoopName, registerHandlers],
  );

  return (
    <ConductorLayoutContext.Provider value={value}>
      {children}
    </ConductorLayoutContext.Provider>
  );
}

export function useConductorLayout() {
  return useContext(ConductorLayoutContext);
}
