import "./patch.js";

import { composeAppServices } from "./bootstrap/composition-root.js";

const appServices = composeAppServices();

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

void appServices.start().catch((error) => {
  console.error("Failed to initialize database:", error);
  process.exit(1);
});

export default appServices.app;
