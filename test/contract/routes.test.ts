import path from "node:path";
import test from "node:test";

import { assertJsonSnapshot } from "./utils/snapshot.js";
import { extractHttpRouteContract } from "./utils/contracts.js";

const repoRoot = process.cwd();

test("HTTP route contract remains unchanged", () => {
  const actual = extractHttpRouteContract(repoRoot);
  const snapshotPath = path.join(repoRoot, "test/contract/snapshots/http-routes.json");
  assertJsonSnapshot(snapshotPath, actual);
});
