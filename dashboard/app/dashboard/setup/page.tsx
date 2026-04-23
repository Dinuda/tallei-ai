"use client";

import Image from "next/image";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Clock3, Link2, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import "./setup-shadcn.css";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ClaudeWizard, ChatGPTWizard, Provider } from "./SetupWizards";

type IntegrationState = "checking" | "connecting" | "connected" | "error" | "not_connected";

type IntegrationStatus = {
  state: IntegrationState;
  connected: boolean;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  canDisconnect: boolean;
  hasBearerToken?: boolean;
  lastTokenUsedAt?: string | null;
  lastTokenCreatedAt?: string | null;
};

type ChatGptTokenStatus = {
  loading: boolean;
  hasActiveToken: boolean;
  activeTokenCount: number;
  lastTokenCreatedAt: string | null;
  lastTokenUsedAt: string | null;
  maskedToken: string | null;
};

type IntegrationStatusMap = {
  claude: IntegrationStatus;
  chatgpt: IntegrationStatus;
};

type ProviderCardConfig = {
  id: Provider;
  name: string;
  subtitle: string;
  highlights: string[];
  icon: () => ReactElement;
  toneClass: string;
};

type BadgeVariant = NonNullable<React.ComponentProps<typeof Badge>["variant"]>;

const DEFAULT_STATUS: IntegrationStatus = {
  state: "not_connected",
  connected: false,
  lastConnectedAt: null,
  lastEventAt: null,
  lastError: null,
  canDisconnect: false,
  hasBearerToken: false,
  lastTokenUsedAt: null,
  lastTokenCreatedAt: null,
};

const DEFAULT_CHATGPT_TOKEN_STATUS: ChatGptTokenStatus = {
  loading: true,
  hasActiveToken: false,
  activeTokenCount: 0,
  lastTokenCreatedAt: null,
  lastTokenUsedAt: null,
  maskedToken: null,
};

const DEFAULT_STATUS_MAP: IntegrationStatusMap = {
  claude: { ...DEFAULT_STATUS },
  chatgpt: { ...DEFAULT_STATUS },
};

const PROVIDERS: ProviderCardConfig[] = [
  {
    id: "claude",
    name: "Claude Desktop",
    subtitle: "Memory across every session",
    highlights: ["One-click desktop flow", "Session continuity without manual sync"],
    icon: ClaudeIcon,
    toneClass: "bg-amber-500",
  },
  {
    id: "chatgpt",
    name: "ChatGPT Projects",
    subtitle: "Import schema + bearer token",
    highlights: ["OpenAPI import for Actions", "Rotating bearer token controls"],
    icon: ChatGPTIcon,
    toneClass: "bg-emerald-500",
  },
];

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
    hasBearerToken: Boolean(value.hasBearerToken),
    lastTokenUsedAt: typeof value.lastTokenUsedAt === "string" ? value.lastTokenUsedAt : null,
    lastTokenCreatedAt: typeof value.lastTokenCreatedAt === "string" ? value.lastTokenCreatedAt : null,
  };
}

function normalizeChatGptTokenStatus(input: unknown): ChatGptTokenStatus {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_CHATGPT_TOKEN_STATUS, loading: false };
  }
  const value = input as Partial<ChatGptTokenStatus>;
  return {
    loading: false,
    hasActiveToken: Boolean(value.hasActiveToken),
    activeTokenCount: Number.isFinite(value.activeTokenCount as number) ? Number(value.activeTokenCount) : 0,
    lastTokenCreatedAt: typeof value.lastTokenCreatedAt === "string" ? value.lastTokenCreatedAt : null,
    lastTokenUsedAt: typeof value.lastTokenUsedAt === "string" ? value.lastTokenUsedAt : null,
    maskedToken: typeof value.maskedToken === "string" ? value.maskedToken : null,
  };
}

function formatStatusDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString();
}

function providerStatusHint(provider: Provider, status: IntegrationStatus): string {
  if (status.state === "checking") return "Checking connector health.";
  if (status.state === "connecting") return "Setup flow in progress.";
  if (status.state === "error") return status.lastError || "Last check returned an error.";

  if (status.state === "connected") {
    if (provider === "chatgpt" && status.hasBearerToken) {
      const tokenDate = formatStatusDate(status.lastTokenUsedAt ?? status.lastTokenCreatedAt);
      return tokenDate ? `Bearer token active. Last token activity ${tokenDate}.` : "Bearer token active.";
    }
    const connectedAt = formatStatusDate(status.lastConnectedAt ?? status.lastEventAt);
    return connectedAt ? `Connected ${connectedAt}.` : "Connector is active.";
  }

  if (provider === "chatgpt" && status.hasBearerToken) {
    return "Token exists. Finish setup to activate integration.";
  }

  return "Not connected yet.";
}

function statusBadge(state: IntegrationState, statusLoading: boolean): {
  label: string;
  variant: BadgeVariant;
  className: string;
} {
  if (statusLoading || state === "checking") {
    return {
      label: "Checking",
      variant: "outline",
      className: "animate-pulse border-border text-muted-foreground",
    };
  }

  if (state === "connecting") {
    return {
      label: "Connecting",
      variant: "outline",
      className: "border-amber-200 bg-amber-50 text-amber-700",
    };
  }

  if (state === "connected") {
    return {
      label: "Connected",
      variant: "outline",
      className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    };
  }

  if (state === "error") {
    return {
      label: "Error",
      variant: "destructive",
      className: "border-red-200 bg-red-50 text-red-700",
    };
  }

  return {
    label: "Not connected",
    variant: "outline",
    className: "border-border text-muted-foreground",
  };
}

function ClaudeIcon() {
  return <Image src="/claude.svg" alt="Claude" width={20} height={20} />;
}

function ChatGPTIcon() {
  return <Image src="/chatgpt.svg" alt="ChatGPT" width={20} height={20} />;
}

function GeminiIcon() {
  return <Image src="/gemini.svg" alt="Gemini" width={20} height={20} />;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

export default function ConnectorsPage() {
  const [selected, setSelected] = useState<Provider>("claude");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusByProvider, setStatusByProvider] = useState<IntegrationStatusMap>(DEFAULT_STATUS_MAP);
  const [chatgptTokenStatus, setChatgptTokenStatus] = useState<ChatGptTokenStatus>(DEFAULT_CHATGPT_TOKEN_STATUS);
  const [generatingChatgptToken, setGeneratingChatgptToken] = useState(false);
  const [disconnectingProvider, setDisconnectingProvider] = useState<Provider | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const mcpUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/mcp`
      : `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/mcp`;

  const loadStatus = useCallback(async () => {
    try {
      const [integrationRes, tokenRes] = await Promise.all([
        fetch("/api/integrations/status"),
        fetch("/api/integrations/chatgpt/token"),
      ]);

      if (integrationRes.ok) {
        const data = await integrationRes.json();
        const integrations = data?.integrations ?? {};
        const nextStatus: IntegrationStatusMap = {
          claude: normalizeIntegrationStatus(integrations?.claude),
          chatgpt: normalizeIntegrationStatus(integrations?.chatgpt),
        };
        setStatusByProvider(nextStatus);
      }

      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        setChatgptTokenStatus(normalizeChatGptTokenStatus(tokenData));
      } else {
        setChatgptTokenStatus((prev) => ({ ...prev, loading: false }));
      }
    } catch {
      setChatgptTokenStatus((prev) => ({ ...prev, loading: false }));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const selectedStatus = statusByProvider[selected];
  const selectedProviderLabel = selected === "claude" ? "Claude" : "ChatGPT";

  const selectedProviderConfig = useMemo(
    () => PROVIDERS.find((provider) => provider.id === selected) ?? PROVIDERS[0],
    [selected]
  );

  async function refreshStatus() {
    setStatusLoading(true);
    setChatgptTokenStatus((prev) => ({ ...prev, loading: true }));
    await loadStatus();
  }

  async function rotateChatGptToken(rotate = false) {
    setGeneratingChatgptToken(true);
    setActionMessage(null);
    setActionError(null);

    try {
      const res = await fetch("/api/integrations/chatgpt/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotate }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message =
          typeof data?.error === "string" ? data.error : "Failed to generate ChatGPT bearer token.";
        throw new Error(message);
      }
      const message =
        typeof data?.message === "string" ? data.message : "ChatGPT bearer token is stored securely.";
      setActionMessage(message);
      await refreshStatus();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to generate ChatGPT bearer token.");
    } finally {
      setGeneratingChatgptToken(false);
    }
  }

  async function disconnectSelectedProvider() {
    const provider = selected;
    const label = provider === "claude" ? "Claude" : "ChatGPT";
    if (!window.confirm(`Disconnect ${label}? This revokes active connector credentials for this integration.`)) {
      return;
    }

    setDisconnectingProvider(provider);
    setActionMessage(null);
    setActionError(null);

    try {
      const res = await fetch("/api/integrations/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = typeof data?.error === "string" ? data.error : `Failed to disconnect ${label}.`;
        throw new Error(message);
      }

      const message = typeof data?.message === "string" ? data.message : `${label} disconnected.`;
      setActionMessage(message);
      await refreshStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to disconnect ${label}.`;
      setActionError(message);
    } finally {
      setDisconnectingProvider(null);
    }
  }

  function openWizard(provider: Provider) {
    setSelected(provider);
    setWizardOpen(true);
  }

  const selectedBadge = statusBadge(selectedStatus.state, statusLoading);
  const selectedLastActivity = formatStatusDate(selectedStatus.lastEventAt ?? selectedStatus.lastConnectedAt);
  const tokenActivity = formatStatusDate(
    chatgptTokenStatus.lastTokenUsedAt ?? chatgptTokenStatus.lastTokenCreatedAt
  );

  return (
    <div className="setup-shadcn-scope mx-auto w-full max-w-7xl space-y-6 px-4 pb-10 pt-4 sm:px-6 lg:px-8">
      <header className="space-y-3">
        <Badge variant="outline" className="w-fit border-border bg-muted/40 text-muted-foreground">
          Memory Connectors
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
          Connect Tallei Memory
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          Configure provider integrations with live status checks, guided setup, and recovery controls.
        </p>
      </header>

      {actionMessage && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <ShieldCheck className="size-4" />
          <AlertDescription className="text-emerald-800">{actionMessage}</AlertDescription>
        </Alert>
      )}

      {actionError && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader className="space-y-2 pb-4">
              <CardTitle className="text-xl font-semibold">Available now</CardTitle>
              <CardDescription>Production connectors ready for setup and runtime use.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {PROVIDERS.map((provider) => {
                const badge = statusBadge(statusByProvider[provider.id].state, statusLoading);
                const isSelected = selected === provider.id;
                const Icon = provider.icon;

                return (
                  <Card
                    key={provider.id}
                    variant="flat"
                    className={cn(
                      "border-border/80 transition-shadow",
                      isSelected && "ring-2 ring-primary/30",
                      "hover:shadow-sm"
                    )}
                  >
                    <CardHeader className="space-y-3 pb-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-muted/40">
                            <Icon />
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="truncate text-lg font-semibold text-foreground">
                              {provider.name}
                            </CardTitle>
                            <CardDescription className="text-sm">{provider.subtitle}</CardDescription>
                          </div>
                        </div>
                        <Badge variant={badge.variant} className={badge.className}>
                          {badge.label}
                        </Badge>
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-3 pb-4">
                      <ul className="space-y-1.5">
                        {provider.highlights.map((item) => (
                          <li key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                            <span className={cn("mt-1.5 size-1.5 rounded-full", provider.toneClass)} />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                      <p
                        className={cn(
                          "text-sm text-muted-foreground",
                          statusByProvider[provider.id].state === "error" && "text-destructive"
                        )}
                      >
                        {providerStatusHint(provider.id, statusByProvider[provider.id])}
                      </p>
                    </CardContent>

                    <Separator />

                    <CardFooter className="grid grid-cols-2 gap-2 pt-4">
                      <Button
                        variant={isSelected ? "default" : "outline"}
                        onClick={() => setSelected(provider.id)}
                      >
                        {isSelected ? "Selected" : "Select"}
                      </Button>
                      <Button variant="secondary" onClick={() => openWizard(provider.id)}>
                        Manage
                      </Button>
                    </CardFooter>
                  </Card>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="space-y-2 pb-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-xl font-semibold">Roadmap</CardTitle>
                  <CardDescription>Upcoming connectors planned for parity and wider coverage.</CardDescription>
                </div>
                <Badge variant="outline" className="border-indigo-200 bg-indigo-50 text-indigo-700">
                  Coming soon
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <Card variant="flat" className="border-border/80 bg-muted/20">
                <CardHeader className="space-y-3 pb-3">
                  <div className="flex items-center gap-3">
                    <div className="grid size-10 place-items-center rounded-lg border border-border bg-background">
                      <GeminiIcon />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Gemini</CardTitle>
                      <CardDescription>Native Tallei memory connector with shared behavior.</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  <p className="flex items-start gap-2">
                    <Sparkles className="mt-0.5 size-4 text-indigo-500" />
                    Gemini-specific setup flow and guided authentication.
                  </p>
                  <p className="flex items-start gap-2">
                    <Link2 className="mt-0.5 size-4 text-indigo-500" />
                    Shared memory parity with existing connectors.
                  </p>
                </CardContent>
                <CardFooter className="pt-4">
                  <Button variant="outline" className="w-full" disabled>
                    Not yet available
                  </Button>
                </CardFooter>
              </Card>
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader className="space-y-2 pb-4">
            <CardTitle className="text-xl font-semibold">Troubleshooting & management</CardTitle>
            <CardDescription>Inspect live state, refresh checks, and run connector actions.</CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <Tabs value={selected} onValueChange={(value) => setSelected(value as Provider)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="claude">Claude</TabsTrigger>
                <TabsTrigger value="chatgpt">ChatGPT</TabsTrigger>
              </TabsList>

              <TabsContent value="claude" className="mt-4 space-y-3">
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">Claude Desktop</p>
                    <Badge variant={selectedBadge.variant} className={selectedBadge.className}>
                      {selectedBadge.label}
                    </Badge>
                  </div>
                  <DetailRow
                    label="Last activity"
                    value={selectedLastActivity ?? "No recent activity"}
                  />
                </div>
              </TabsContent>

              <TabsContent value="chatgpt" className="mt-4 space-y-3">
                <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2.5">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">ChatGPT Projects</p>
                    <Badge variant={selectedBadge.variant} className={selectedBadge.className}>
                      {selectedBadge.label}
                    </Badge>
                  </div>
                  <DetailRow
                    label="Token"
                    value={
                      chatgptTokenStatus.loading
                        ? "Checking..."
                        : chatgptTokenStatus.hasActiveToken
                          ? chatgptTokenStatus.maskedToken || "Active"
                          : "Not available"
                    }
                  />
                  <DetailRow
                    label="Last token activity"
                    value={tokenActivity ?? "No token activity"}
                  />
                  <DetailRow
                    label="Active token count"
                    value={String(chatgptTokenStatus.activeTokenCount)}
                  />
                </div>
              </TabsContent>
            </Tabs>

            <div
              className={cn(
                "rounded-lg border p-3 text-sm",
                selectedStatus.state === "error"
                  ? "border-destructive/30 bg-destructive/5 text-destructive"
                  : "border-border bg-muted/20 text-muted-foreground"
              )}
            >
              {selectedStatus.state === "error" && selectedStatus.lastError
                ? selectedStatus.lastError
                : providerStatusHint(selected, selectedStatus)}
            </div>
          </CardContent>

          <Separator />

          <CardFooter className="flex flex-col gap-2 pt-4">
            <Button className="w-full" onClick={() => openWizard(selected)}>
              Manage {selectedProviderConfig.name}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => void refreshStatus()}
              disabled={statusLoading || disconnectingProvider !== null || generatingChatgptToken}
            >
              <RefreshCw className={cn("size-4", statusLoading && "animate-spin")} />
              Refresh status
            </Button>

            {selected === "chatgpt" && (
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => void rotateChatGptToken(chatgptTokenStatus.hasActiveToken)}
                disabled={generatingChatgptToken || statusLoading || disconnectingProvider !== null}
              >
                {generatingChatgptToken
                  ? "Working..."
                  : chatgptTokenStatus.hasActiveToken
                    ? "Rotate bearer token"
                    : "Generate bearer token"}
              </Button>
            )}

            <Button
              variant="destructive"
              className="w-full"
              onClick={() => void disconnectSelectedProvider()}
              disabled={statusLoading || disconnectingProvider !== null || !selectedStatus.canDisconnect}
            >
              {disconnectingProvider === selected ? "Disconnecting..." : `Disconnect ${selectedProviderLabel}`}
            </Button>

            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock3 className="size-3.5" />
              Live state reflects the latest successful status check.
            </p>
          </CardFooter>
        </Card>
      </div>

      {selected === "claude" && (
        <ClaudeWizard isOpen={wizardOpen && selected === "claude"} onClose={() => setWizardOpen(false)} mcpUrl={mcpUrl} />
      )}

      {selected === "chatgpt" && (
        <ChatGPTWizard
          isOpen={wizardOpen && selected === "chatgpt"}
          onClose={() => setWizardOpen(false)}
          tokenStatus={chatgptTokenStatus}
          generatingToken={generatingChatgptToken}
          onGenerateToken={rotateChatGptToken}
        />
      )}
    </div>
  );
}
