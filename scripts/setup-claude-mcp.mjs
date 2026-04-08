#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function resolveClaudeConfigPath() {
  const customPath = getArgValue("--config");
  if (customPath) return path.resolve(customPath);

  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }

  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function ensureParentDir(filePath) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
}

function backupIfExists(filePath) {
  if (!fs.existsSync(filePath)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.backup-${ts}`;
  fs.copyFileSync(filePath, backupPath);
  console.log(`Backup written: ${backupPath}`);
}

function main() {
  const fromArg = getArgValue("--api-key");
  const apiKey = fromArg || process.env.TALLEI_API_KEY || process.env.AUTHORIZATION;

  if (!apiKey) {
    console.error("Missing API key. Provide --api-key <KEY> or set TALLEI_API_KEY.");
    process.exit(1);
  }

  const authorization = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
  const configPath = resolveClaudeConfigPath();
  const repoRoot = process.cwd();
  const bridgePath = path.resolve(getArgValue("--bridge") || path.join(repoRoot, "mcp-bridge.js"));
  const serverName = getArgValue("--server-name") || "tallei";

  if (!fs.existsSync(bridgePath)) {
    console.error(`Bridge file not found: ${bridgePath}`);
    process.exit(1);
  }

  let config;
  try {
    config = readJsonIfExists(configPath);
  } catch (error) {
    console.error(`Failed to parse existing config at ${configPath}`);
    console.error(String(error));
    process.exit(1);
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    console.error(`Claude config must be a JSON object. Found invalid structure in ${configPath}`);
    process.exit(1);
  }

  const next = {
    ...config,
    mcpServers: {
      ...(config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {}),
      [serverName]: {
        command: "node",
        args: [bridgePath],
        env: {
          AUTHORIZATION: authorization
        }
      }
    }
  };

  ensureParentDir(configPath);
  backupIfExists(configPath);
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  console.log(`Claude MCP server '${serverName}' configured.`);
  console.log(`Config path: ${configPath}`);
  console.log("Restart Claude Desktop to load the updated MCP config.");
}

main();
