export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function readIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid integer env var: ${name}`);
  }
  return value;
}

export function readOptionalIntEnv(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw === "") return null;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid integer env var: ${name}`);
  }
  return value;
}

export function readFloatEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid float env var: ${name}`);
  }
  return value;
}

export function readBooleanEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  return raw === "true";
}

export function readStringEnv(env: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  const raw = env[name];
  if (raw === undefined) return fallback;
  return raw;
}

export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return value;

  try {
    const parsed = new URL(value);
    if (parsed.pathname === "/mcp" || parsed.pathname.endsWith("/mcp/")) {
      parsed.pathname = "/";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  }
}
