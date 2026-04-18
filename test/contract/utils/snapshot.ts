import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

export function assertJsonSnapshot<T>(snapshotPath: string, actual: T): void {
  const update = process.env["UPDATE_CONTRACT_SNAPSHOTS"] === "true";
  const prettyActual = JSON.stringify(actual, null, 2);

  if (update) {
    writeFileSync(snapshotPath, `${prettyActual}\n`, "utf8");
    return;
  }

  const expectedRaw = readFileSync(snapshotPath, "utf8");
  const expected = JSON.parse(expectedRaw) as T;
  assert.deepEqual(actual, expected);
}
