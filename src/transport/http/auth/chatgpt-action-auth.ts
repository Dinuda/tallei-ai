import type { NextFunction, Response } from "express";
import type { AuthContext } from "../../../domain/auth/index.js";
import { setRequestTimingField } from "../../../observability/request-timing.js";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import { resolveChatGptInternalAuth } from "./chatgpt-internal-auth.js";
import {
  applyChatGptContinuationHeader,
  attachChatGptAuthContinuation,
  resolveChatGptProviderAuth,
  resolveDeferredChatGptProviderAuth,
} from "./chatgpt-provider-auth.js";

function noteAuthTiming(authStartedAt: bigint): void {
  const authMs = Number(process.hrtime.bigint() - authStartedAt) / 1_000_000;
  setRequestTimingField("auth_ms", authMs);
}

export async function resolveChatGptActionAuth(req: AuthRequest, res: Response): Promise<AuthContext | null> {
  if (req.authContext) return req.authContext;

  const deferred = await resolveDeferredChatGptProviderAuth(req, res);
  if (!deferred) return null;
  attachChatGptAuthContinuation(res, deferred);
  return deferred;
}

export async function chatGptActionAuthMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authStartedAt = process.hrtime.bigint();

  const internal = await resolveChatGptInternalAuth(req, res);
  if (internal) {
    attachChatGptAuthContinuation(res, internal);
    noteAuthTiming(authStartedAt);
    next();
    return;
  }
  if (res.headersSent) {
    noteAuthTiming(authStartedAt);
    return;
  }

  const continued = await applyChatGptContinuationHeader(req);
  if (continued) {
    noteAuthTiming(authStartedAt);
    next();
    return;
  }

  const provider = await resolveChatGptProviderAuth(req, res);
  if (provider) {
    attachChatGptAuthContinuation(res, provider);
    noteAuthTiming(authStartedAt);
    next();
    return;
  }
  if (res.headersSent) {
    noteAuthTiming(authStartedAt);
    return;
  }

  // Deferred API key auth path: request may proceed and resolve at action handler boundary.
  if (req.authModeHint === "api_key" && req.authPromise) {
    noteAuthTiming(authStartedAt);
    next();
    return;
  }

  noteAuthTiming(authStartedAt);
}
