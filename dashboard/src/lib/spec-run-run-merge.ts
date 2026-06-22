type SpecRunInteractionLike = {
  id: string;
  status: string;
  decision_json?: Record<string, unknown>;
};

export type SpecRunProjectionLike = {
  status: string;
  interactions?: SpecRunInteractionLike[];
  operatorView?: unknown;
  error_json?: { message?: string };
};

const RESOLVED_INTERACTION_STATUSES = new Set(["approved", "rejected", "submitted"]);
const WAITING_STATUSES = new Set(["waiting_for_interaction", "waiting_for_approval"]);

function mergeInteractions(
  local: SpecRunInteractionLike[],
  server: SpecRunInteractionLike[],
): SpecRunInteractionLike[] {
  const byId = new Map(server.map((interaction) => [interaction.id, interaction]));
  for (const localInteraction of local) {
    const serverInteraction = byId.get(localInteraction.id);
    if (!serverInteraction) continue;
    if (
      localInteraction.status !== "pending"
      && serverInteraction.status === "pending"
      && RESOLVED_INTERACTION_STATUSES.has(localInteraction.status)
    ) {
      byId.set(localInteraction.id, {
        ...serverInteraction,
        status: localInteraction.status,
        decision_json: localInteraction.decision_json ?? serverInteraction.decision_json,
      });
    }
  }
  return [...byId.values()];
}

function shouldPreserveRunningStatus(local: SpecRunProjectionLike, server: SpecRunProjectionLike): boolean {
  if (local.status !== "running") return false;
  if (!WAITING_STATUSES.has(server.status)) return false;
  const localInteractions = local.interactions ?? [];
  const serverInteractions = server.interactions ?? [];
  return localInteractions.some((entry) => {
    if (entry.status === "pending") return false;
    const serverEntry = serverInteractions.find((candidate) => candidate.id === entry.id);
    return serverEntry?.status === "pending";
  });
}

/** Merge server run projection without clobbering optimistic gate resolution. */
export function mergeSpecRunProjection<T extends SpecRunProjectionLike>(
  local: T,
  server: T,
): T {
  const interactions = mergeInteractions(local.interactions ?? [], server.interactions ?? []);
  const status = shouldPreserveRunningStatus(local, server) ? "running" : server.status;
  return {
    ...server,
    status,
    interactions,
  };
}
