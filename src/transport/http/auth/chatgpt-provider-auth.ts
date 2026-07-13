import { createPrivateKey, createPublicKey, randomUUID } from "crypto";
import type { Response } from "express";
import jwt from "jsonwebtoken";
import type { AuthContext } from "../../../domain/auth/index.js";
import { config } from "../../../config/index.js";
import {
  isJwtRevokedJti,
  peekLocalApiKeyValidation,
  validateApiKeyContext,
} from "../../../infrastructure/auth/auth.js";
import { getPlanForTenant } from "../../../infrastructure/auth/tenancy.js";
import { validateOAuthAccessToken } from "../../../infrastructure/auth/oauth-tokens.js";
import { setRequestTimingField } from "../../../observability/request-timing.js";
import type { AuthRequest } from "../middleware/auth.middleware.js";

const PLAN_CACHE_TTL_MS = 5 * 60_000;
const AUTH_CONTINUATION_HEADER = "X-Tallei-Auth-Continuation";
const AUTH_CONTINUATION_TTL_SECONDS = Math.max(60, config.authContinuationTtlSeconds);
const AUTH_CONTINUATION_ISSUER = "tallei-chatgpt-actions";
const AUTH_CONTINUATION_AUDIENCE = "chatgpt-actions";
const planCache = new Map<string, { plan: AuthContext["plan"]; exp: number }>();

type ContinuationPayload = {
  userId: string;
  tenantId: string;
  authMode: AuthContext["authMode"];
  plan: AuthContext["plan"];
  keyId?: string;
  connectorType?: string | null;
  clientId?: string;
  scopes?: string[];
};

type ContinuationSigningConfig = {
  useEs256: boolean;
  signKey: jwt.Secret | Parameters<typeof createPrivateKey>[0];
  verifyKey: jwt.Secret | Parameters<typeof createPublicKey>[0];
};

function normalizePem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const unquoted =
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return unquoted.replace(/\\n/g, "\n");
}

function resolveContinuationSigningConfig(): ContinuationSigningConfig {
  const fallbackSecret = config.apiKeyPepper || config.internalApiSecret;
  const privatePem = normalizePem(config.authContinuationPrivateKey);
  const publicPem = normalizePem(config.authContinuationPublicKey);

  if (!privatePem || !publicPem) {
    return { useEs256: false, signKey: fallbackSecret, verifyKey: fallbackSecret };
  }

  try {
    const privateKey = createPrivateKey(privatePem);
    const publicKey = createPublicKey(publicPem);

    if (privateKey.type !== "private" || publicKey.type !== "public") {
      throw new Error("continuation key pair must include private/public asymmetric keys");
    }
    if (privateKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyType !== "ec") {
      throw new Error("continuation key pair must be EC keys for ES256");
    }

    return { useEs256: true, signKey: privateKey, verifyKey: publicKey };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[chatgpt] invalid auth continuation ES256 key configuration; falling back to HS256 (${reason})`);
    return { useEs256: false, signKey: fallbackSecret, verifyKey: fallbackSecret };
  }
}

const CONTINUATION_SIGNING = resolveContinuationSigningConfig();
const AUTH_CONTINUATION_USE_ES256 = CONTINUATION_SIGNING.useEs256;

function continuationSignKey(): jwt.Secret {
  return CONTINUATION_SIGNING.signKey as jwt.Secret;
}

function continuationVerifyKey(): jwt.Secret {
  return CONTINUATION_SIGNING.verifyKey as jwt.Secret;
}

function encodeAuthContinuation(auth: AuthContext): string {
  const payload: ContinuationPayload = {
    userId: auth.userId,
    tenantId: auth.tenantId,
    authMode: auth.authMode,
    plan: auth.plan,
    keyId: auth.keyId,
    connectorType: auth.connectorType ?? null,
    clientId: auth.clientId,
    scopes: auth.scopes ?? [],
  };
  return jwt.sign(payload, continuationSignKey(), {
    algorithm: AUTH_CONTINUATION_USE_ES256 ? "ES256" : "HS256",
    expiresIn: AUTH_CONTINUATION_TTL_SECONDS,
    issuer: AUTH_CONTINUATION_ISSUER,
    audience: AUTH_CONTINUATION_AUDIENCE,
    jwtid: randomUUID(),
  });
}

async function decodeAuthContinuation(raw: string): Promise<AuthContext | null> {
  const token = raw.trim();
  if (!token) return null;

  let parsed: jwt.JwtPayload;
  try {
    const verified = jwt.verify(token, continuationVerifyKey(), {
      algorithms: AUTH_CONTINUATION_USE_ES256 ? ["ES256"] : ["HS256"],
      issuer: AUTH_CONTINUATION_ISSUER,
      audience: AUTH_CONTINUATION_AUDIENCE,
    });
    if (!verified || typeof verified === "string") return null;
    parsed = verified;
  } catch {
    return null;
  }

  const jti = typeof parsed.jti === "string" ? parsed.jti : null;
  if (jti) {
    const revoked = await isJwtRevokedJti(jti);
    if (revoked) return null;
  }

  const userId = typeof parsed.userId === "string" ? parsed.userId : "";
  const tenantId = typeof parsed.tenantId === "string" ? parsed.tenantId : "";
  const authMode = typeof parsed.authMode === "string" ? parsed.authMode : "";
  const plan = typeof parsed.plan === "string" ? parsed.plan : "";
  if (!userId || !tenantId || !authMode || !plan) return null;

  return {
    userId,
    tenantId,
    authMode: authMode as AuthContext["authMode"],
    plan: plan as AuthContext["plan"],
    keyId: typeof parsed.keyId === "string" ? parsed.keyId : undefined,
    connectorType: typeof parsed.connectorType === "string" ? parsed.connectorType : null,
    clientId: typeof parsed.clientId === "string" ? parsed.clientId : undefined,
    scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
  };
}

export function attachChatGptAuthContinuation(res: Response, auth: AuthContext): void {
  try {
    res.setHeader(AUTH_CONTINUATION_HEADER, encodeAuthContinuation(auth));
    setRequestTimingField("auth_continuation_issued", true);
    setRequestTimingField("auth_continuation_alg", AUTH_CONTINUATION_USE_ES256 ? "ES256" : "HS256");
  } catch (error) {
    setRequestTimingField("auth_continuation_issued", false);
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[chatgpt] failed to issue auth continuation token (${reason})`);
  }
}

function getCachedPlanSync(tenantId: string): AuthContext["plan"] | null {
  const cached = planCache.get(tenantId);
  if (!cached || cached.exp <= Date.now()) return null;
  return cached.plan;
}

async function cachedPlan(tenantId: string): Promise<AuthContext["plan"]> {
  const cached = getCachedPlanSync(tenantId);
  if (cached) return cached;
  const plan = await getPlanForTenant(tenantId);
  planCache.set(tenantId, { plan, exp: Date.now() + PLAN_CACHE_TTL_MS });
  return plan;
}

function toApiKeyContext(
  validation: { keyId: string; userId: string; tenantId: string; connectorType: string | null; plan: AuthContext["plan"] }
): AuthContext {
  return {
    userId: validation.userId,
    tenantId: validation.tenantId,
    authMode: "api_key",
    plan: validation.plan,
    keyId: validation.keyId,
    connectorType: validation.connectorType,
  };
}

export async function applyChatGptContinuationHeader(req: AuthRequest): Promise<AuthContext | null> {
  const continuationHeader = req.headers["x-tallei-auth-continuation"];
  if (typeof continuationHeader !== "string" || continuationHeader.trim().length === 0) return null;
  const continued = await decodeAuthContinuation(continuationHeader);
  setRequestTimingField("auth_continuation_hit", Boolean(continued));
  if (!continued) return null;
  req.userId = continued.userId;
  req.authContext = continued;
  return continued;
}

export async function resolveChatGptProviderAuth(req: AuthRequest, res: Response): Promise<AuthContext | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return null;
  }

  const isLikelyApiKey = token.startsWith("tly_") || token.startsWith("gm_");
  if (isLikelyApiKey) {
    req.authModeHint = "api_key";
    const localValidation = peekLocalApiKeyValidation(token, req.ip);
    if (localValidation) {
      const localContext = toApiKeyContext(localValidation);
      if (localContext.connectorType && localContext.connectorType !== "chatgpt") {
        res.status(403).json({ error: "API key is not valid for ChatGPT actions" });
        return null;
      }
      req.userId = localContext.userId;
      req.authContext = localContext;
      return localContext;
    }

    req.authPromise = validateApiKeyContext(token, req.ip).then((validation) => {
      if (!validation) return null;
      const context = toApiKeyContext(validation);
      if (context.connectorType && context.connectorType !== "chatgpt") {
        req.authFailure = { status: 403, error: "API key is not valid for ChatGPT actions" };
        return null;
      }
      return context;
    }).catch((error) => {
      console.error("ChatGPT deferred API key auth failed:", error);
      req.authFailure = { status: 500, error: "Server error validating bearer token" };
      return null;
    });

    setRequestTimingField("auth_deferred", true);
    return null;
  }

  try {
    const tokenContext = await validateOAuthAccessToken(token);
    if (!tokenContext) {
      res.status(401).json({ error: "Invalid bearer token" });
      return null;
    }

    const plan = await cachedPlan(tokenContext.tenantId);
    const auth: AuthContext = {
      userId: tokenContext.userId,
      tenantId: tokenContext.tenantId,
      authMode: "oauth",
      plan,
      clientId: tokenContext.clientId,
      scopes: tokenContext.scopes,
    };
    req.userId = auth.userId;
    req.authContext = auth;
    return auth;
  } catch (error) {
    console.error("ChatGPT action auth failed:", error);
    res.status(500).json({ error: "Server error validating bearer token" });
    return null;
  }
}

export async function resolveDeferredChatGptProviderAuth(req: AuthRequest, res: Response): Promise<AuthContext | null> {
  if (req.authContext) return req.authContext;
  if (req.authModeHint !== "api_key") return null;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token) {
      const localValidation = peekLocalApiKeyValidation(token, req.ip);
      if (localValidation) {
        const localContext = toApiKeyContext(localValidation);
        if (localContext.connectorType && localContext.connectorType !== "chatgpt") {
          res.status(403).json({ error: "API key is not valid for ChatGPT actions" });
          return null;
        }
        req.userId = localContext.userId;
        req.authContext = localContext;
        setRequestTimingField("auth_deferred_wait_ms", 0);
        return localContext;
      }
    }
  }

  if (!req.authPromise) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  try {
    const waitStartedAt = process.hrtime.bigint();
    const resolved = await req.authPromise;
    const waitedMs = Number(process.hrtime.bigint() - waitStartedAt) / 1_000_000;
    setRequestTimingField("auth_deferred_wait_ms", waitedMs);
    if (!resolved) {
      if (req.authFailure) {
        res.status(req.authFailure.status).json({ error: req.authFailure.error });
      } else {
        res.status(401).json({ error: "Unauthorized" });
      }
      return null;
    }
    req.userId = resolved.userId;
    req.authContext = resolved;
    return resolved;
  } catch (error) {
    console.error("ChatGPT deferred auth resolution failed:", error);
    res.status(500).json({ error: "Server error validating bearer token" });
    return null;
  }
}
