"use client";

import { useEffect, useState } from "react";
import type { IconType } from "react-icons";
import { FaTelegramPlane } from "react-icons/fa";
import { MdMarkEmailRead } from "react-icons/md";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Send,
  ShieldCheck,
  Star,
  Trash2,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import styles from "./page.module.css";

type ChannelKind = "telegram" | "gmail" | "email";

type ChannelView = {
  id: string;
  kind: ChannelKind;
  destination: string;
  enabled: boolean;
  isPrimary: boolean;
  status: string;
  label: string | null;
  verifiedAt: string | null;
  lastError: string | null;
};

type ChannelMessage = {
  id: string;
  channelId: string;
  kind: ChannelKind;
  direction: "inbound" | "outbound";
  body: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

type SetupSession = {
  id: string;
  kind: ChannelKind;
  status: string;
  deepLinkUrl: string | null;
  pairingCode: string | null;
  metadata: Record<string, unknown>;
};

type Payload = {
  channels: ChannelView[];
  messages: ChannelMessage[];
};

type ChannelCardDefinition = {
  key: "telegram" | "inbox";
  setupKind: Extract<ChannelKind, "telegram" | "gmail">;
  matchKinds: ChannelKind[];
  title: string;
  description: string;
  icon: IconType;
  iconClassName: string;
  logoClassName: string;
  beta?: boolean;
};

const DEFINITIONS: ChannelCardDefinition[] = [
  {
    key: "telegram",
    setupKind: "telegram",
    matchKinds: ["telegram"],
    title: "Telegram",
    description: "Route loop discovery, approvals, and status updates through a Telegram bot chat.",
    icon: FaTelegramPlane,
    iconClassName: styles.telegramIcon,
    logoClassName: styles.telegramLogo,
    beta: true,
  },
  {
    key: "inbox",
    setupKind: "gmail",
    matchKinds: ["gmail", "email"],
    title: "Inbox",
    description: "Enabled by default from signup for loop updates, approvals, and replies.",
    icon: MdMarkEmailRead,
    iconClassName: styles.inboxIcon,
    logoClassName: styles.inboxLogo,
  },
];

function formatTimestamp(value: string): string {
  try {
    return new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function channelName(kind: ChannelKind): string {
  if (kind === "telegram") return "Telegram";
  return "Inbox";
}

function messageSubject(message: ChannelMessage): string {
  const subject = message.metadata?.subject;
  if (typeof subject === "string" && subject.trim()) return subject.trim();
  const firstLine = message.body.split(/\n+/).find((line) => line.trim().length > 0);
  return firstLine?.trim() || "Channel message";
}

function messagePreview(message: ChannelMessage): string {
  const subject = messageSubject(message);
  const normalized = message.body.replace(/\s+/g, " ").trim();
  const withoutSubject = normalized.startsWith(subject) ? normalized.slice(subject.length).trim() : normalized;
  return withoutSubject || normalized || "No message body";
}

export default function ChannelsPage() {
  const [data, setData] = useState<Payload>({ channels: [], messages: [] });
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, SetupSession>>({});
  const [botToken, setBotToken] = useState("");
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false);

  async function load() {
    setError(null);
    const res = await fetch("/api/channels", { cache: "no-store" });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload?.error || "Failed to load channels");
    }
    setData({
      channels: Array.isArray(payload.channels) ? payload.channels : [],
      messages: Array.isArray(payload.messages) ? payload.messages : [],
    });
  }

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load channels");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function refreshWithToast(nextNotice?: string) {
    await load();
    if (nextNotice) toast.success(nextNotice);
  }

  function telegramSetupMessage(mode?: "default" | "botfather"): string {
    return mode === "botfather" ? "Telegram bot token saved" : "Telegram setup link opened";
  }

  function inboxSetupMessage(): string {
    return "Inbox connected";
  }

  async function startSetup(kind: ChannelKind, mode?: "default" | "botfather") {
    setBusyKey(`start-${kind}`);
    setError(null);
    try {
      const res = await fetch("/api/channels/setup/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          ...(mode ? { mode } : {}),
          ...(mode === "botfather" && botToken.trim() ? { bot_token: botToken.trim() } : {}),
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to start setup");
      const session = payload.session as SetupSession;
      setSessions((current) => ({ ...current, [kind]: session }));
      await refreshWithToast(kind === "telegram" ? telegramSetupMessage(mode) : inboxSetupMessage());
      if (session.deepLinkUrl) {
        window.open(session.deepLinkUrl, "_blank", "noopener,noreferrer");
      }
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : "Failed to start setup");
    } finally {
      setBusyKey(null);
    }
  }

  async function completeSetup(kind: ChannelKind) {
    const session = sessions[kind];
    if (!session) return;
    setBusyKey(`complete-${kind}`);
    setError(null);
    try {
      const res = await fetch(`/api/channels/setup/${session.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "telegram" && botToken.trim() ? { bot_token: botToken.trim() } : {}),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to complete setup");
      setSessions((current) => ({ ...current, [kind]: payload.session as SetupSession }));
      toast.success(kind === "telegram" ? "Telegram setup saved" : inboxSetupMessage());
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : "Failed to complete setup");
    } finally {
      setBusyKey(null);
    }
  }

  async function sendTest(channelId: string) {
    setBusyKey(`test-${channelId}`);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${channelId}/test`, { method: "POST" });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to send test message");
      await load();
      toast.success("Test message sent");
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Failed to send test message");
    } finally {
      setBusyKey(null);
    }
  }

  async function disconnect(channelId: string) {
    setBusyKey(`disconnect-${channelId}`);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${channelId}`, { method: "DELETE" });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to disconnect channel");
      await load();
      toast.success("Channel disconnected");
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : "Failed to disconnect channel");
    } finally {
      setBusyKey(null);
    }
  }

  function currentChannel(definition: ChannelCardDefinition): ChannelView | null {
    return data.channels.find((channel) => definition.matchKinds.includes(channel.kind) && channel.enabled) ?? null;
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Channels</h1>
          <p className={styles.pageSubtitle}>
            Control where loops send updates, approval gates, and replies.
          </p>
        </div>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => {
            setBusyKey("refresh");
            void load()
              .then(() => toast.success("Channels refreshed"))
              .catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh"))
              .finally(() => setBusyKey(null));
          }}
          disabled={loading || busyKey === "refresh"}
          title="Refresh channels"
        >
          <RefreshCw size={16} className={busyKey === "refresh" ? styles.spin : ""} />
          Refresh
        </button>
      </div>

      {error ? (
        <div className={`${styles.banner} ${styles.error}`}>
          <AlertCircle size={14} />
          {error}
        </div>
      ) : null}

      <Dialog open={telegramDialogOpen} onOpenChange={setTelegramDialogOpen}>
        <DialogContent className={styles.dialogContent}>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>Telegram setup</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              Use the shared Tallei bot or provide a BotFather token for a bring-your-own bot flow.
            </DialogDescription>
          </DialogHeader>

          <div className={styles.dialogBody}>
            <div className={styles.dialogSection}>
              <div className={styles.dialogLead}>Shared bot</div>
              <p className={styles.dialogText}>
                Start a managed Telegram session and finish the `/start` link in the bot chat.
              </p>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => void startSetup("telegram", "default")}
                disabled={loading || busyKey !== null}
              >
                <ShieldCheck size={14} />
                Connect shared bot
              </button>
            </div>

            <div className={styles.dialogSection}>
              <div className={styles.dialogLead}>BotFather token</div>
              <p className={styles.dialogText}>
                Provide your bot token if you want Telegram delivery and approvals to run through your own bot.
              </p>
              <input
                className={styles.input}
                placeholder="Paste BotFather token"
                value={botToken}
                onChange={(event) => setBotToken(event.target.value)}
              />
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => void startSetup("telegram", "botfather")}
                disabled={loading || busyKey !== null || botToken.trim().length === 0}
              >
                <Send size={14} />
                Use BotFather token
              </button>
            </div>

            {sessions.telegram ? (
              <div className={styles.dialogSection}>
                <div className={styles.dialogLead}>Pending setup</div>
                <p className={styles.dialogText}>
                  Finish the current Telegram setup session, then complete the flow here.
                </p>
                <div className={styles.dialogActions}>
                  {sessions.telegram.deepLinkUrl ? (
                    <a className={styles.setupLink} href={sessions.telegram.deepLinkUrl} target="_blank" rel="noreferrer">
                      Open setup link
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => void completeSetup("telegram")}
                    disabled={loading || busyKey !== null}
                  >
                    <RefreshCw size={14} />
                    Complete
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <div className={styles.grid}>
        {DEFINITIONS.map((definition) => {
          const channel = currentChannel(definition);
          const session = sessions[definition.setupKind];
          const Icon = definition.icon;
          const isInbox = definition.key === "inbox";
          const statusLabel = channel ? "Connected" : session?.status === "pending" ? "Connecting" : "Not connected";
          const statusClass = channel
            ? styles.statusConnected
            : session?.status === "pending"
              ? styles.statusConnecting
              : styles.statusIdle;
          return (
            <section key={definition.key} className={styles.channelCard}>
              <div className={styles.cardHeader}>
                <div className={`${styles.logoWrap} ${definition.logoClassName}`}>
                  <Icon className={definition.iconClassName} size={22} />
                </div>
                <div>
                  <div className={styles.cardTitleRow}>
                    <h2 className={styles.cardTitle}>{definition.title}</h2>
                    {definition.beta ? <span className={styles.betaTag}>beta</span> : null}
                  </div>
                  <p className={styles.cardDescription}>{definition.description}</p>
                </div>
              </div>

              <div className={styles.cardBody}>
                <div className={`${styles.statusPill} ${statusClass}`}>
                  {channel ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                  {statusLabel}
                </div>
                {channel?.isPrimary ? (
                  <div className={`${styles.statusPill} ${styles.statusPrimary}`}>
                    <Star size={13} />
                    Primary
                  </div>
                ) : null}
                <p className={styles.statusDetail}>
                  {channel
                    ? `${isInbox ? "Default mail route" : "Beta route"}: ${channel.destination}`
                    : session?.deepLinkUrl
                      ? "Setup link ready"
                      : isInbox
                        ? "Created automatically from the signup email."
                        : "Connect to test Telegram delivery."}
                </p>
              </div>

              {session?.deepLinkUrl && definition.key === "inbox" ? (
                <a className={styles.setupLink} href={session.deepLinkUrl} target="_blank" rel="noreferrer">
                  Open setup link
                </a>
              ) : null}

              <div className={styles.cardFooter}>
                {!channel ? (
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    onClick={() => {
                      if (definition.key === "telegram") {
                        setTelegramDialogOpen(true);
                        return;
                      }
                      void startSetup(definition.setupKind, "default");
                    }}
                    disabled={loading || busyKey !== null}
                  >
                    <ShieldCheck size={14} />
                    Connect
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => void sendTest(channel.id)}
                      disabled={loading || busyKey !== null}
                    >
                      <Send size={14} />
                      Test
                    </button>
                    <button
                      type="button"
                      className={styles.dangerBtn}
                      onClick={() => void disconnect(channel.id)}
                      disabled={loading || busyKey !== null}
                    >
                      <Trash2 size={14} />
                      Disconnect
                    </button>
                  </>
                )}

                {session && !channel ? (
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => {
                      if (definition.key === "telegram") {
                        setTelegramDialogOpen(true);
                        return;
                      }
                      void completeSetup(definition.setupKind);
                    }}
                    disabled={loading || busyKey !== null}
                  >
                    <RefreshCw size={14} />
                    {definition.key === "telegram" ? "Continue setup" : "Complete"}
                  </button>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      <section className={styles.activitySection}>
        <div className={styles.activityHeader}>
          <div>
            <h2 className={styles.sectionTitle}>Recent activity</h2>
            <p className={styles.sectionSubtitle}>Latest database records sent and received through loop channels.</p>
          </div>
          <span className={styles.countPill}>{data.messages.length} entries</span>
        </div>
        {data.messages.length === 0 ? (
          <div className={styles.empty}>No recent channel records were found in the database.</div>
        ) : (
          <div className={styles.tableShell}>
            <Table className={styles.inboxTable}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Flow</TableHead>
                  <TableHead scope="col">Channel</TableHead>
                  <TableHead scope="col">Message</TableHead>
                  <TableHead scope="col">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.messages.map((message) => (
                  <TableRow key={message.id}>
                    <TableCell>
                      <span className={`${styles.directionPill} ${message.direction === "inbound" ? styles.inbound : styles.outbound}`}>
                        {message.direction}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className={styles.channelCell}>
                        <span className={`${styles.channelDot} ${message.kind === "telegram" ? styles.channelDotTelegram : styles.channelDotInbox}`} />
                        {channelName(message.kind)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className={styles.messageCell}>
                        <span className={styles.messageSubject}>{messageSubject(message)}</span>
                        <span className={styles.messagePreview}>{messagePreview(message)}</span>
                      </div>
                    </TableCell>
                    <TableCell className={styles.timeCell}>{formatTimestamp(message.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
