import type { NextFunction, Request, Response } from "express";
import { config } from "../../../config/index.js";

export function errorHandlerMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (config.nodeEnv !== "production" && error instanceof Error) {
    console.error("[error-handler]", error);
  }
  res.status(500).json({ error: "Internal Server Error" });
}
