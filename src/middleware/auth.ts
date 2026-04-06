import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { validateApiKey } from "../services/auth.js";

export interface AuthRequest extends Request {
  userId?: string;
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.split(" ")[1];

  // Check if it's an API Key (e.g. starts with gm_)
  if (token.startsWith("gm_")) {
    try {
      const userId = await validateApiKey(token);
      if (!userId) {
        res.status(401).json({ error: "Invalid API key" });
        return;
      }
      req.userId = userId;
      next();
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Server error validating API key" });
    }
  } else {
    // Treat as JWT
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as { id: string };
      req.userId = decoded.id;
      next();
    } catch (e) {
      res.status(401).json({ error: "Invalid or expired JWT token" });
    }
  }
}
