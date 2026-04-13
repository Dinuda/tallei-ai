import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const DEFAULT_MCP_URL = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const SESSION_PATH = path.join(os.homedir(), ".config", "tallei", "mcp-oauth-session.json");
const DEFAULT_SCOPES = "mcp:tools memory:read memory:write";

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function ensureSessionDir() {
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
}

function readSession() {
  if (!fs.existsSync(SESSION_PATH)) return null;
  try {
    const raw = fs.readFileSync(SESSION_PATH, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeSession(session) {
  ensureSessionDir();
  fs.writeFileSync(SESSION_PATH, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

function clearSession() {
  if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH);
}

function normalizeBaseUrl(raw) {
  const parsed = new URL(raw);
  if (parsed.pathname === "/mcp" || parsed.pathname.endsWith("/mcp/")) {
    parsed.pathname = "/";
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isTokenFresh(session) {
  return typeof session?.accessTokenExpiresAt === "number" && session.accessTokenExpiresAt - nowSeconds() > 45;
}

function spawnDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      spawnDetached("open", [url]);
      return true;
    }
    if (process.platform === "win32") {
      spawnDetached("cmd", ["/c", "start", "", url]);
      return true;
    }
    spawnDetached("xdg-open", [url]);
    return true;
  } catch {
    return false;
  }
}

async function postForm(url, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") {
      body.set(key, String(value));
    }
  }

  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function ensureRegisteredClient(baseUrl, existingClientId) {
  if (existingClientId) return existingClientId;

  const response = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Tallei MCP Bridge",
      redirect_uris: ["http://127.0.0.1:3000/bridge-callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: DEFAULT_SCOPES,
    }),
  });
  const data = await safeJson(response);
  if (!response.ok || typeof data.client_id !== "string") {
    throw new Error(`Failed to register OAuth client (${response.status})`);
  }
  return data.client_id;
}

async function refreshTokens(session) {
  const response = await postForm(`${session.baseUrl}/token`, {
    grant_type: "refresh_token",
    client_id: session.clientId,
    refresh_token: session.refreshToken,
    resource: session.resource,
  });
  const data = await safeJson(response);
  if (!response.ok || typeof data.access_token !== "string") {
    throw new Error(data.error_description || "Failed to refresh OAuth token");
  }

  const refreshed = {
    ...session,
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : session.refreshToken,
    accessTokenExpiresAt: nowSeconds() + (Number(data.expires_in) || 3600),
    updatedAt: new Date().toISOString(),
  };
  writeSession(refreshed);
  return refreshed;
}

async function runLogin(mcpUrl) {
  const baseUrl = normalizeBaseUrl(mcpUrl);
  const existing = readSession();
  const reusableClientId = existing?.baseUrl === baseUrl ? existing.clientId : undefined;
  const clientId = await ensureRegisteredClient(baseUrl, reusableClientId);
  const { verifier, challenge } = createPkcePair();

  const authorizeRes = await fetch(`${baseUrl}/api/oauth/device/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      scope: DEFAULT_SCOPES,
      resource: mcpUrl,
      code_challenge: challenge,
    }),
  });
  const authPayload = await safeJson(authorizeRes);
  if (!authorizeRes.ok || typeof authPayload.device_code !== "string") {
    throw new Error(authPayload.error_description || "Failed to start device authorization flow");
  }

  const verificationUrl = authPayload.verification_uri_complete || authPayload.verification_uri;
  if (typeof verificationUrl !== "string") {
    throw new Error("Authorization server did not return a verification URL");
  }

  const opened = openBrowser(verificationUrl);
  if (!opened) {
    console.log("Open this URL in your browser to continue:");
    console.log(verificationUrl);
  }

  console.log("Waiting for browser approval...");
  const intervalSeconds = Number(authPayload.interval) || 5;
  const startedAt = Date.now();
  const timeoutMs = (Number(authPayload.expires_in) || 600) * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
    const tokenRes = await postForm(`${baseUrl}/api/oauth/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: authPayload.device_code,
      code_verifier: verifier,
    });
    const tokenData = await safeJson(tokenRes);
    if (tokenRes.ok && typeof tokenData.access_token === "string") {
      const session = {
        baseUrl,
        mcpUrl,
        resource: mcpUrl,
        clientId,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        accessTokenExpiresAt: nowSeconds() + (Number(tokenData.expires_in) || 3600),
        scopes: typeof tokenData.scope === "string" ? tokenData.scope : DEFAULT_SCOPES,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      writeSession(session);
      console.log("Login successful.");
      return;
    }

    if (tokenData.error === "authorization_pending" || tokenData.error === "slow_down") {
      continue;
    }
    throw new Error(tokenData.error_description || tokenData.error || "Device login failed");
  }

  throw new Error("Timed out waiting for OAuth device authorization");
}

function runStatus() {
  const session = readSession();
  if (!session) {
    console.log("Status: not logged in");
    return;
  }
  const expiresIn = Number(session.accessTokenExpiresAt) - nowSeconds();
  const safeClient = typeof session.clientId === "string" ? session.clientId.slice(0, 14) : "unknown";
  console.log("Status: logged in");
  console.log(`Client: ${safeClient}...`);
  console.log(`MCP URL: ${session.mcpUrl}`);
  console.log(`Token: ${expiresIn > 0 ? `valid for ~${expiresIn}s` : "expired"}`);
}

async function runLogout() {
  const session = readSession();
  if (!session) {
    console.log("No session to clear.");
    return;
  }
  try {
    await postForm(`${session.baseUrl}/revoke`, {
      client_id: session.clientId,
      token: session.refreshToken || session.accessToken,
    });
  } catch {
    // best effort
  }
  clearSession();
  console.log("Logged out.");
}

async function runConnect(mcpUrl) {
  let session = readSession();
  if (!session) {
    throw new Error("Missing OAuth session. Run `node mcp-bridge.js login` first.");
  }

  if (mcpUrl && session.mcpUrl !== mcpUrl) {
    session = {
      ...session,
      mcpUrl,
      resource: mcpUrl,
      baseUrl: normalizeBaseUrl(mcpUrl),
    };
    writeSession(session);
  }

  if (!isTokenFresh(session)) {
    session = await refreshTokens(session);
  }

  const httpTransport = new StreamableHTTPClientTransport(new URL(session.mcpUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    },
  });
  const stdioTransport = new StdioServerTransport();

  httpTransport.onmessage = (message) => {
    void stdioTransport.send(message).catch(console.error);
  };
  stdioTransport.onmessage = (message) => {
    void httpTransport.send(message).catch(console.error);
  };

  httpTransport.onerror = async (error) => {
    // Retry once on token expiry with refresh, then continue reporting.
    const message = String(error ?? "");
    if (/401|invalid_token|expired/i.test(message)) {
      try {
        const refreshed = await refreshTokens(readSession() ?? session);
        session = refreshed;
      } catch {
        // ignore refresh failures here, caller will see transport errors
      }
    }
    console.error("HTTP transport error:", error);
  };

  stdioTransport.onerror = (error) => {
    console.error("Stdio transport error:", error);
  };

  process.on("SIGINT", () => {
    void httpTransport.close();
    void stdioTransport.close();
    process.exit(0);
  });

  await httpTransport.start();
  await stdioTransport.start();
}

function printHelp() {
  console.log("Tallei MCP OAuth bridge");
  console.log("");
  console.log("Usage:");
  console.log("  node mcp-bridge.js login      # Browser OAuth login (device + PKCE)");
  console.log("  node mcp-bridge.js status     # Session status");
  console.log("  node mcp-bridge.js logout     # Revoke local session");
  console.log("  node mcp-bridge.js connect    # Start stdio<->HTTP MCP bridge");
  console.log("");
  console.log("Environment:");
  console.log("  MCP_URL=https://your-domain/mcp");
}

async function main() {
  const command = (process.argv[2] || "connect").toLowerCase();
  const mcpUrl = process.env.MCP_URL ?? DEFAULT_MCP_URL;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "login") {
    await runLogin(mcpUrl);
    return;
  }
  if (command === "status") {
    runStatus();
    return;
  }
  if (command === "logout") {
    await runLogout();
    return;
  }
  if (command === "connect") {
    await runConnect(mcpUrl);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
