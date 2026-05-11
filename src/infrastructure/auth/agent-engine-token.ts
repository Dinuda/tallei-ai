import jwt from "jsonwebtoken";

import { config } from "../../config/index.js";
import type { AuthContext, Plan } from "../../domain/auth/index.js";

interface AgentEngineTokenPayload {
  sub: string;
  tid: string;
  plan?: Plan;
  iss?: string;
  aud?: string;
}

export function signAgentEngineToken(input: {
  userId: string;
  tenantId: string;
  plan?: Plan;
  expiresInSeconds?: number;
}): string {
  return jwt.sign(
    {
      sub: input.userId,
      tid: input.tenantId,
      plan: input.plan ?? "free",
      iss: config.agentEngineIssuer,
      aud: "tallei-agent-tools",
    },
    config.internalApiSecret,
    { algorithm: "HS256", expiresIn: input.expiresInSeconds ?? 900 }
  );
}

export function verifyAgentEngineToken(token: string): AuthContext {
  const payload = jwt.verify(token, config.internalApiSecret, {
    algorithms: ["HS256"],
    audience: "tallei-agent-tools",
    issuer: config.agentEngineIssuer,
  }) as AgentEngineTokenPayload;

  if (!payload.sub || !payload.tid) {
    throw new Error("Agent token is missing tenant or user claims");
  }

  return {
    userId: payload.sub,
    tenantId: payload.tid,
    authMode: "internal",
    plan: payload.plan ?? "free",
    connectorType: "agent_engine",
  };
}
