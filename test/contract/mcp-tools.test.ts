import path from "node:path";
import test from "node:test";

import { assertJsonSnapshot } from "./utils/snapshot.js";
import { extractMcpToolContract } from "./utils/contracts.js";

const repoRoot = process.cwd();

test("MCP tool contract remains unchanged", () => {
  const actual = extractMcpToolContract(repoRoot);
  const snapshotPath = path.join(repoRoot, "test/contract/snapshots/mcp-tools.json");
  assertJsonSnapshot(snapshotPath, actual);
});
