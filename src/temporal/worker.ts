import path from "node:path";
import { fileURLToPath } from "node:url";

import { NativeConnection, Worker } from "@temporalio/worker";

import { config } from "../config/index.js";
import * as activities from "./activities/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run(): Promise<void> {
  if (!config.temporalEnabled) {
    console.error("TALLEI_TEMPORAL__ENABLED is false. Set it to true before starting the Temporal worker.");
    process.exit(1);
  }

  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.temporalTaskQueue,
    workflowsPath: path.join(__dirname, "workflows"),
    activities,
  });

  console.log(`Temporal worker listening on queue "${config.temporalTaskQueue}" (${config.temporalAddress})`);
  await worker.run();
}

run().catch((error) => {
  console.error("Temporal worker failed:", error);
  process.exit(1);
});
