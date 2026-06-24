import { NativeConnection, Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { config } from "../config/index.js";
import * as activities from "./activities/index.js";

async function run() {
  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  const workflowsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "workflows");

  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.temporalTaskQueue,
    workflowsPath,
    activities,
  });

  console.log(`[temporal] worker listening on ${config.temporalTaskQueue}`);
  await worker.run();
}

run().catch((error) => {
  console.error("[temporal] worker failed", error);
  process.exit(1);
});
