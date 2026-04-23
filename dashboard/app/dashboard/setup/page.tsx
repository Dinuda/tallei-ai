"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

type IntegrationState = "checking" | "connecting" | "connected" | "error" | "not_connected";

type IntegrationStatus = {
  state: IntegrationState;
  connected: boolean;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  canDisconnect: boolean;
};

type IntegrationStatusMap = {
  claude: IntegrationStatus;
  chatgpt: IntegrationStatus;
};

type Connector = {
  id: keyof IntegrationStatusMap;
  name: string;
  plan: string;
  icon: string;
};

const CONNECTORS: Connector[] = [
  {
    id: "claude",
    name: "Claude Desktop",
    plan: "Free plan",
    icon: "/claude.svg",
  },
  {
    id: "chatgpt",
    name: "ChatGPT Projects",
    plan: "Free plan",
    icon: "/chatgpt.svg",
  },
];

const DEFAULT_STATUS: IntegrationStatus = {
  state: "not_connected",
  connected: false,
  lastConnectedAt: null,
  lastEventAt: null,
  lastError: null,
  canDisconnect: false,
};

const DEFAULT_STATUS_MAP: IntegrationStatusMap = {
  claude: { ...DEFAULT_STATUS },
  chatgpt: { ...DEFAULT_STATUS },
};

function normalizeState(value: unknown): IntegrationState {
  if (
    value === "checking" ||
    value === "connecting" ||
    value === "connected" ||
    value === "error" ||
    value === "not_connected"
  ) {
    return value;
  }
  return "not_connected";
}

function normalizeIntegrationStatus(input: unknown): IntegrationStatus {
  if (!input || typeof input !== "object") return { ...DEFAULT_STATUS };
  const value = input as Partial<IntegrationStatus>;
  return {
    state: normalizeState(value.state),
    connected: Boolean(value.connected),
    lastConnectedAt: typeof value.lastConnectedAt === "string" ? value.lastConnectedAt : null,
    lastEventAt: typeof value.lastEventAt === "string" ? value.lastEventAt : null,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
    canDisconnect: Boolean(value.canDisconnect),
  };
}

export default function ConnectorsPage() {
  const [statusByProvider, setStatusByProvider] = useState<IntegrationStatusMap>(DEFAULT_STATUS_MAP);
  const [loading, setLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/status");
      if (res.ok) {
        const data = await res.json();
        const integrations = data?.integrations ?? {};
        setStatusByProvider({
          claude: normalizeIntegrationStatus(integrations?.claude),
          chatgpt: normalizeIntegrationStatus(integrations?.chatgpt),
        });
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-foreground">Connectors</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect external data sources to automatically import content
        </p>
      </header>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {CONNECTORS.map((connector, index) => {
          const isLast = index === CONNECTORS.length - 1;

          return (
            <div
              key={connector.id}
              className={`flex items-center justify-between px-6 py-5 ${
                !isLast ? "border-b border-border" : ""
              }`}
            >
              <div className="flex items-center gap-4">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                  <Image
                    src={connector.icon}
                    alt={connector.name}
                    width={24}
                    height={24}
                    className="opacity-90"
                  />
                </div>
                <div>
                  <div className="font-medium text-foreground">{connector.name}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                    <Lock className="size-3" />
                    <span>{connector.plan}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-6">
                <span className="text-sm text-muted-foreground">
                  {loading ? "Checking..." : "Requires Pro plan to connect"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 px-4 text-xs font-medium tracking-wide"
                  disabled={loading}
                >
                  UPGRADE
                  <ArrowUpRight className="ml-1.5 size-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
