import type { Express } from "express";

export interface AppServices {
  readonly app: Express;
  readonly mcpPublicUrl: URL;
  start(): Promise<void>;
  stop(): Promise<void>;
}
