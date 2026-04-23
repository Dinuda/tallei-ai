"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Activity,
  Clock,
  FileText,
  ListFilter,
  RefreshCw,
  User,
} from "lucide-react";
import styles from "./page.module.css";

type McpEvent = {
  id: string;
  authMode: string | null;
  method: string;
  toolName: string | null;
  ok: boolean;
  error: string | null;
  createdAt: string;
};

type TimeFilter = "all" | "1d" | "7d" | "30d";

const PLATFORM_STYLES: Record<string, { label: string; tone: string }> = {
  claude: { label: "Claude", tone: styles.platformClaude },
  chatgpt: { label: "ChatGPT", tone: styles.platformChatgpt },
  other: { label: "Other", tone: styles.platformOther },
};

function platformStyle(p: string) {
  return PLATFORM_STYLES[(p || "other").toLowerCase()] ?? PLATFORM_STYLES.other;
}

function relativeDate(iso: string, now: number): string {
  if (!iso || !now) return "—";
  const diff = now - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (secs < 60) return `${Math.max(0, secs)}s ago`;
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function EmptyState() {
  return (
    <div className={styles.emptyState}>
      <h3>No activity yet</h3>
      <p>Send a message from Claude or ChatGPT and refresh to see MCP events.</p>
    </div>
  );
}

export default function McpEventsPage() {
  const [events, setEvents] = useState<McpEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState<number>(Date.now());
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");

  const fetchEvents = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);

    try {
      const res = await fetch("/api/mcp-events?limit=100", { cache: "no-store" });
      const data = await res.json();
      setEvents(Array.isArray(data?.events) ? data.events : []);
    } catch {
      setEvents([]);
    } finally {
      if (mode === "initial") setLoading(false);
      if (mode === "refresh") setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchEvents("initial");
    const interval = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  const filteredEvents = useMemo(() => {
    if (timeFilter === "all") return events;

    const nowMs = Date.now();
    const msPerDay = 1000 * 60 * 60 * 24;
    const rangeDays = timeFilter === "1d" ? 1 : timeFilter === "7d" ? 7 : 30;
    const cutoff = nowMs - rangeDays * msPerDay;

    return events.filter((event) => new Date(event.createdAt).getTime() >= cutoff);
  }, [events, timeFilter]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Activity</h1>
          <p className={styles.pageSubtitle}>Track connector calls and MCP tool events.</p>
        </div>
        <div className={styles.headerRight}>
          <div className={styles.timeFilters}>
            {(["all", "1d", "7d", "30d"] as const).map((filter) => (
              <button
                key={filter}
                className={`${styles.timeFilterBtn} ${timeFilter === filter ? styles.timeFilterBtnActive : ""}`}
                onClick={() => setTimeFilter(filter)}
              >
                {filter === "all" ? "All" : filter}
              </button>
            ))}
          </div>

          <button className={styles.iconBtn} aria-label="Filters">
            <ListFilter size={16} />
          </button>

          <button
            onClick={() => void fetchEvents("refresh")}
            disabled={loading || refreshing}
            className={styles.actionBtn}
          >
            <RefreshCw size={16} className={refreshing ? styles.spin : ""} />
            Refresh
          </button>
        </div>
      </header>

      {loading && events.length === 0 ? (
        <div className={styles.skeletonStack}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className={styles.skeletonRow} />
          ))}
        </div>
      ) : filteredEvents.length === 0 ? (
        <EmptyState />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>
                  <span><Clock size={14} /> Time</span>
                </th>
                <th>
                  <span><User size={14} /> Platform</span>
                </th>
                <th>
                  <span><Activity size={14} /> Action</span>
                </th>
                <th>
                  <span><FileText size={14} /> Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.map((event, idx) => {
                const platform = platformStyle(event.authMode || "other");
                const isSuccess = event.ok;

                return (
                  <tr key={event.id} className={idx < filteredEvents.length - 1 ? styles.rowBorder : ""}>
                    <td>{relativeDate(event.createdAt, now)}</td>
                    <td>
                      <span className={`${styles.platformBadge} ${platform.tone}`}>
                        <User size={12} /> {platform.label}
                      </span>
                    </td>
                    <td>
                      <div className={styles.actionCell}>
                        <span className={`${styles.statusPill} ${isSuccess ? styles.statusOk : styles.statusError}`}>
                          {isSuccess ? "200 OK" : "ERROR"}
                        </span>
                        <code className={styles.methodCode}>{event.toolName || event.method}</code>
                      </div>
                    </td>
                    <td>
                      {event.error ? (
                        <div className={styles.errorBox}>{event.error}</div>
                      ) : (
                        <span className={styles.noDetail}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
