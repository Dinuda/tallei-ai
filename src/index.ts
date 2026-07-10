import "./patch.js";

import { buildContainer } from "./bootstrap/composition-root.js";

const appServices = buildContainer();

async function start(): Promise<void> {
  await appServices.start();
}

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await appServices.stop();
  } catch (error) {
    console.error(`Failed to shutdown cleanly on ${signal}:`, error);
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void start().catch((error) => {
  console.error("Failed to start Tallei:", error);
  process.exit(1);
});
