import { randomUUID } from "crypto";

import type { AuthContext } from "../../../domain/auth/index.js";
import { dicebearDylanUrl } from "./personas/agent-personas.js";
import {
  bindAvatarRow,
  deleteUnboundAvatarsForSpec,
  findAvatarRow,
  insertAllocatedAvatarRow,
  type AvatarRow,
} from "../data/avatar.repository.js";
import { loopSpecExists } from "../data/spec.repository.js";

export { loopSpecExists };

export type AgentAvatarView = {
  id: string;
  seed: string;
  style: string;
  url: string;
  status: "allocated" | "bound";
  boundSpecId: string | null;
  boundAgentId: string | null;
  boundAt: string | null;
  createdAt: string;
};

function mapAvatarRow(row: AvatarRow): AgentAvatarView {
  return {
    id: row.id,
    seed: row.seed,
    style: row.style,
    url: dicebearDylanUrl(row.seed),
    status: row.status === "bound" ? "bound" : "allocated",
    boundSpecId: row.bound_spec_id,
    boundAgentId: row.bound_agent_id,
    boundAt: row.bound_at ? new Date(row.bound_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function allocateAgentAvatars(
  auth: AuthContext,
  count = 1,
): Promise<AgentAvatarView[]> {
  const safeCount = Math.max(1, Math.min(20, Math.floor(count)));
  const seeds = Array.from({ length: safeCount }, () => randomUUID());
  const rows = await Promise.all(
    seeds.map((seed) => insertAllocatedAvatarRow(auth, seed)),
  );
  return rows.map(mapAvatarRow);
}

export async function bindAgentAvatar(
  auth: AuthContext,
  avatarId: string,
  input: { specId: string; agentId: string },
): Promise<AgentAvatarView> {
  const existing = await findAvatarRow(auth, avatarId);
  if (!existing) throw new Error("Avatar not found");
  if (existing.status === "bound") throw new Error("Avatar is already bound and cannot be reused");

  const bound = await bindAvatarRow(auth, avatarId, input.specId, input.agentId);
  if (!bound) throw new Error("Avatar bind failed");
  return mapAvatarRow(bound);
}

export async function releaseUnboundAvatarsForSpec(
  auth: AuthContext,
  specId: string,
): Promise<number> {
  return deleteUnboundAvatarsForSpec(auth, specId);
}
