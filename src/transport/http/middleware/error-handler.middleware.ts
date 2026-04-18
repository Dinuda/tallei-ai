import type { NextFunction, Request, Response } from "express";

export function errorHandlerMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const message = error instanceof Error ? error.message : "Internal Server Error";
  res.status(500).json({ error: message });
}
