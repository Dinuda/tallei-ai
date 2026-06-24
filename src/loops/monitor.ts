import type { MonitorConfig } from "./spec.js";

export type MonitorSample = Record<string, unknown>;

export function evaluateMonitorRule(sample: MonitorSample, rule: MonitorConfig["rule"]): boolean {
  const raw = sample[rule.field];
  if (raw === undefined || raw === null) return false;

  if (typeof rule.value === "number") {
    const numeric = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(numeric)) return false;
    switch (rule.op) {
      case "gt": return numeric > rule.value;
      case "gte": return numeric >= rule.value;
      case "lt": return numeric < rule.value;
      case "lte": return numeric <= rule.value;
      case "eq": return numeric === rule.value;
      default: return false;
    }
  }

  const text = String(raw);
  switch (rule.op) {
    case "eq": return text === String(rule.value);
    default: return false;
  }
}

export function buildMonitorAlertMessage(
  monitor: MonitorConfig,
  sample: MonitorSample,
  breached: boolean,
): string {
  const value = sample[monitor.rule.field];
  if (!breached) {
    return `Monitor OK: ${monitor.rule.field}=${String(value)} (threshold ${monitor.rule.op} ${monitor.rule.value})`;
  }
  return `Alert: ${monitor.rule.field}=${String(value)} breached threshold ${monitor.rule.op} ${monitor.rule.value}`;
}
