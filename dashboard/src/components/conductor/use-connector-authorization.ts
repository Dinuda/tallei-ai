"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "@/lib/api-fetch";

export type ConnectorAuthPhase = "idle" | "checking" | "redirecting" | "verifying" | "connecting" | "fatal";

export const PENDING_CONNECTOR_KEY = "tallei.pendingConnectorAuthorization";
export const CONNECTOR_RETURN_URL_KEY = "tallei.connectorReturnUrl";

const MAX_OAUTH_RESTARTS = 3;
const VERIFY_TIMEOUT_MS = 10_000;
const VERIFY_POLL_ATTEMPTS = 3;
const VERIFY_POLL_DELAY_MS = 1_500;
const AUTHORIZE_RETRY_DELAY_MS = 800;

type ConnectorStatus = {
  connected?: boolean;
  error?: string;
  code?: string;
};

type AuthorizationResult = {
  redirectUrl?: string;
  connectionRequestId?: string;
  error?: string;
  code?: string;
};

type PendingSessionPayload = Record<string, unknown> & {
  toolkit?: string;
  connectionRequestId?: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function retryCountKey(toolkit: string) {
  return `tallei.connectorOAuthRetries:${toolkit.toLowerCase()}`;
}

function getRetryCount(toolkit: string): number {
  return Number(window.sessionStorage.getItem(retryCountKey(toolkit)) ?? "0");
}

function incrementRetryCount(toolkit: string): number {
  const next = getRetryCount(toolkit) + 1;
  window.sessionStorage.setItem(retryCountKey(toolkit), String(next));
  return next;
}

function clearRetryCount(toolkit: string) {
  window.sessionStorage.removeItem(retryCountKey(toolkit));
}

export function formatToolkitLabel(toolkit: string) {
  return toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
}

function resolveFatalMessage(code: string | undefined, error: string | undefined, toolkit: string): string {
  const label = formatToolkitLabel(toolkit);
  if (code === "COMPOSIO_NOT_CONFIGURED") {
    return `${label} connections are not available in this environment. Choose another app.`;
  }
  if (code === "AUTH_CONFIG_UNAVAILABLE") {
    return `${label} isn't available to connect yet. Choose another app.`;
  }
  return error ?? `Could not connect ${label}. Choose another app or restart connection.`;
}

function isFatalErrorCode(code?: string): boolean {
  return code === "COMPOSIO_NOT_CONFIGURED" || code === "AUTH_CONFIG_UNAVAILABLE";
}

async function fetchConnectionStatus(toolkit: string): Promise<ConnectorStatus & { ok: boolean }> {
  const response = await apiFetch(`/api/connectors/status/${encodeURIComponent(toolkit)}`);
  const status = await response.json().catch(() => ({})) as ConnectorStatus;
  return { ...status, ok: response.ok };
}

async function requestAuthorization(toolkit: string): Promise<AuthorizationResult & { ok: boolean }> {
  const response = await apiFetch(`/api/connectors/${encodeURIComponent(toolkit)}/authorize`, {
    method: "POST",
    body: JSON.stringify({ callbackUrl: `${window.location.origin}/connect/complete` }),
  });
  const authorization = await response.json().catch(() => ({})) as AuthorizationResult;
  return { ...authorization, ok: response.ok };
}

async function verifyAuthorization(
  toolkit: string,
  connectionRequestId: string,
): Promise<ConnectorStatus & { ok: boolean }> {
  const response = await apiFetch(
    `/api/connectors/authorize/${encodeURIComponent(connectionRequestId)}/verify`,
    {
      method: "POST",
      body: JSON.stringify({ toolkit, timeoutMs: VERIFY_TIMEOUT_MS }),
    },
  );
  const status = await response.json().catch(() => ({})) as ConnectorStatus;
  return { ...status, ok: response.ok };
}

function persistPendingSession(payload: PendingSessionPayload) {
  window.sessionStorage.setItem(PENDING_CONNECTOR_KEY, JSON.stringify(payload));
  window.sessionStorage.setItem(CONNECTOR_RETURN_URL_KEY, window.location.href);
}

function clearPendingSession() {
  window.sessionStorage.removeItem(PENDING_CONNECTOR_KEY);
  window.sessionStorage.removeItem(CONNECTOR_RETURN_URL_KEY);
}

function redirectToAuthorization(redirectUrl: string) {
  window.location.assign(redirectUrl);
}

type UseConnectorAuthorizationOptions = {
  toolkit: string | null;
  onConnected: () => void;
  pendingSession?: {
    buildPayload: (toolkit: string, connectionRequestId: string) => PendingSessionPayload;
    canRestore?: (payload: PendingSessionPayload) => boolean;
  };
  initialAuth?: {
    redirectUrl?: string;
    connectionRequestId?: string;
  };
  autoStart?: boolean;
  returnedFromAuthKey?: string | null;
};

export function useConnectorAuthorization({
  toolkit,
  onConnected,
  pendingSession,
  initialAuth,
  autoStart = false,
  returnedFromAuthKey = null,
}: UseConnectorAuthorizationOptions) {
  const [phase, setPhase] = useState<ConnectorAuthPhase>("idle");
  const [fatalMessage, setFatalMessage] = useState<string | null>(null);
  const [connectionRequestId, setConnectionRequestId] = useState<string | null>(
    initialAuth?.connectionRequestId ?? null,
  );
  const inFlightRef = useRef(false);
  const restoredRef = useRef(false);
  const autoStartedRef = useRef(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const busy = phase === "checking" || phase === "redirecting" || phase === "verifying" || phase === "connecting";

  const statusLabel = useMemo(() => {
    if (!toolkit) return "";
    const label = formatToolkitLabel(toolkit);
    switch (phase) {
      case "checking":
        return `Verifying ${label}…`;
      case "redirecting":
        return `Connect ${label} to continue`;
      case "verifying":
        return `Confirming ${label} connection…`;
      case "connecting":
        return `Connecting ${label}…`;
      case "fatal":
        return fatalMessage ?? `${label} connection not completed`;
      default:
        return "";
    }
  }, [fatalMessage, phase, toolkit]);

  const setFatal = useCallback((message: string) => {
    setPhase("fatal");
    setFatalMessage(message);
  }, []);

  const beginAuthorization = useCallback(async (
    targetToolkit: string,
    sessionPayload?: PendingSessionPayload,
  ): Promise<boolean> => {
    if (getRetryCount(targetToolkit) >= MAX_OAUTH_RESTARTS) {
      setFatal(`Could not connect ${formatToolkitLabel(targetToolkit)} after several attempts. Choose another app or restart connection.`);
      return false;
    }

    setPhase("connecting");
    setFatalMessage(null);

    let authorization = await requestAuthorization(targetToolkit);
    if (!authorization.ok && isRecoverableErrorCode(authorization.code)) {
      await sleep(AUTHORIZE_RETRY_DELAY_MS);
      authorization = await requestAuthorization(targetToolkit);
    }

    if (!authorization.ok || !authorization.redirectUrl || !authorization.connectionRequestId) {
      if (isFatalErrorCode(authorization.code)) {
        setFatal(resolveFatalMessage(authorization.code, authorization.error, targetToolkit));
        return false;
      }
      incrementRetryCount(targetToolkit);
      if (getRetryCount(targetToolkit) < MAX_OAUTH_RESTARTS) {
        return beginAuthorization(targetToolkit, sessionPayload);
      }
      setFatal(resolveFatalMessage(authorization.code, authorization.error, targetToolkit));
      return false;
    }

    setConnectionRequestId(authorization.connectionRequestId);
    setPhase("redirecting");
    if (sessionPayload || pendingSession) {
      const payload = sessionPayload ?? pendingSession!.buildPayload(
        targetToolkit,
        authorization.connectionRequestId,
      );
      persistPendingSession({
        ...payload,
        toolkit: targetToolkit,
        connectionRequestId: authorization.connectionRequestId,
      });
    } else if (returnedFromAuthKey) {
      window.sessionStorage.setItem(returnedFromAuthKey, "1");
      window.sessionStorage.setItem(CONNECTOR_RETURN_URL_KEY, window.location.href);
    }
    redirectToAuthorization(authorization.redirectUrl);
    return true;
  }, [pendingSession, returnedFromAuthKey, setFatal]);

  const pollVerify = useCallback(async (
    targetToolkit: string,
    requestId: string,
  ): Promise<boolean> => {
    setPhase("verifying");
    for (let attempt = 0; attempt < VERIFY_POLL_ATTEMPTS; attempt += 1) {
      const status = await verifyAuthorization(targetToolkit, requestId);
      if (status.ok && status.connected) {
        clearRetryCount(targetToolkit);
        clearPendingSession();
        if (returnedFromAuthKey) window.sessionStorage.removeItem(returnedFromAuthKey);
        setPhase("idle");
        setConnectionRequestId(null);
        setFatalMessage(null);
        onConnectedRef.current();
        return true;
      }
      if (isFatalErrorCode(status.code)) {
        setFatal(resolveFatalMessage(status.code, status.error, targetToolkit));
        return false;
      }
      if (attempt < VERIFY_POLL_ATTEMPTS - 1) {
        await sleep(VERIFY_POLL_DELAY_MS);
      }
    }
    return false;
  }, [returnedFromAuthKey, setFatal]);

  const ensureConnected = useCallback(async (
    targetToolkit: string,
    sessionPayload?: PendingSessionPayload,
  ) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setFatalMessage(null);
    try {
      setPhase("checking");
      const status = await fetchConnectionStatus(targetToolkit);
      if (status.ok && status.connected) {
        clearRetryCount(targetToolkit);
        clearPendingSession();
        setPhase("idle");
        onConnectedRef.current();
        return;
      }

      await beginAuthorization(targetToolkit, sessionPayload);
    } finally {
      inFlightRef.current = false;
    }
  }, [beginAuthorization]);

  const resumeAfterReturn = useCallback(async (targetToolkit: string, requestId: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const verified = await pollVerify(targetToolkit, requestId);
      if (verified) return;

      incrementRetryCount(targetToolkit);
      setConnectionRequestId(null);

      let sessionPayload: PendingSessionPayload | undefined;
      const stored = window.sessionStorage.getItem(PENDING_CONNECTOR_KEY);
      if (stored) {
        try {
          sessionPayload = JSON.parse(stored) as PendingSessionPayload;
        } catch {
          sessionPayload = undefined;
        }
      }
      clearPendingSession();

      await beginAuthorization(targetToolkit, sessionPayload);
    } finally {
      inFlightRef.current = false;
    }
  }, [beginAuthorization, pollVerify]);

  const restartConnection = useCallback(() => {
    if (!toolkit) return;
    clearRetryCount(toolkit);
    setFatalMessage(null);
    setPhase("idle");
    setConnectionRequestId(null);
    void ensureConnected(toolkit);
  }, [ensureConnected, toolkit]);

  const reset = useCallback(() => {
    if (toolkit) clearRetryCount(toolkit);
    setPhase("idle");
    setFatalMessage(null);
    setConnectionRequestId(null);
    clearPendingSession();
    if (returnedFromAuthKey) window.sessionStorage.removeItem(returnedFromAuthKey);
  }, [returnedFromAuthKey, toolkit]);

  useEffect(() => {
    if (restoredRef.current || !toolkit || !pendingSession) return;
    restoredRef.current = true;
    const stored = window.sessionStorage.getItem(PENDING_CONNECTOR_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as PendingSessionPayload;
      if (!parsed.toolkit || !parsed.connectionRequestId) return;
      if (parsed.toolkit !== toolkit) return;
      if (pendingSession.canRestore && !pendingSession.canRestore(parsed)) return;
      setConnectionRequestId(parsed.connectionRequestId);
      void resumeAfterReturn(parsed.toolkit, parsed.connectionRequestId);
    } catch {
      clearPendingSession();
    }
  }, [pendingSession, resumeAfterReturn, toolkit]);

  useEffect(() => {
    if (!toolkit || !returnedFromAuthKey || !connectionRequestId) return;
    if (!window.sessionStorage.getItem(returnedFromAuthKey)) return;
    void resumeAfterReturn(toolkit, connectionRequestId);
  }, [connectionRequestId, resumeAfterReturn, returnedFromAuthKey, toolkit]);

  useEffect(() => {
    if (!autoStart || !toolkit || !initialAuth?.redirectUrl || autoStartedRef.current) return;
    if (returnedFromAuthKey && window.sessionStorage.getItem(returnedFromAuthKey)) return;
    autoStartedRef.current = true;
    setPhase("redirecting");
    if (returnedFromAuthKey) {
      window.sessionStorage.setItem(returnedFromAuthKey, "1");
    }
    window.sessionStorage.setItem(CONNECTOR_RETURN_URL_KEY, window.location.href);
    redirectToAuthorization(initialAuth.redirectUrl);
  }, [autoStart, initialAuth?.redirectUrl, returnedFromAuthKey, toolkit]);

  return {
    phase,
    busy,
    statusLabel,
    fatalMessage,
    connectionRequestId,
    ensureConnected,
    resumeAfterReturn,
    restartConnection,
    reset,
    canRestart: phase === "fatal",
  };
}

function isRecoverableErrorCode(code?: string): boolean {
  return !isFatalErrorCode(code);
}
