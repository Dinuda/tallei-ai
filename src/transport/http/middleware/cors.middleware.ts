import type { RequestHandler } from "express";
import cors from "cors";

export function createCorsMiddleware(allowedOrigins: readonly string[]): RequestHandler {
  return cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  });
}
