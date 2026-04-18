import type { AuthContext } from "../../domain/auth/index.js";

interface DeleteMemoryUseCaseDeps {
  readonly memoryRepository: {
    softDeleteScoped(auth: AuthContext, memoryId: string): Promise<unknown>;
    logEvent(input: {
      auth: AuthContext;
      action: string;
      memoryId?: string;
      ipHash?: string | null;
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  readonly vectorRepository: {
    deleteMemoryVector(auth: AuthContext, memoryId: string): Promise<void>;
  };
  readonly noteVectorFailure: (error: unknown, context: string) => void;
  readonly noteMemoryDbFailure: (error: unknown, context: string) => void;
  readonly invalidateRecallCache: (auth: AuthContext) => void;
  readonly invalidateRecallV2Cache: (auth: AuthContext) => void;
  readonly bumpRecallStamp: (auth: AuthContext) => Promise<void>;
  readonly markSnapshotStale: (auth: AuthContext) => Promise<void>;
  readonly queueSnapshotRefresh: (auth: AuthContext, reason: string, delayMs: number) => Promise<void>;
  readonly ipHash: (ip?: string) => string | null;
}

export interface DeleteMemoryUseCaseInput {
  readonly memoryId: string;
  readonly auth: AuthContext;
  readonly requesterIp?: string;
}

export class DeleteMemoryUseCase {
  private readonly deps: DeleteMemoryUseCaseDeps;

  constructor(deps: DeleteMemoryUseCaseDeps) {
    this.deps = deps;
  }

  async execute(input: DeleteMemoryUseCaseInput): Promise<void> {
    const deleted = await this.deps.memoryRepository.softDeleteScoped(input.auth, input.memoryId);
    if (!deleted) {
      throw new Error("Memory not found or not owned by user");
    }

    try {
      await this.deps.vectorRepository.deleteMemoryVector(input.auth, input.memoryId);
    } catch (error) {
      this.deps.noteVectorFailure(error, "delete");
    }

    void this.deps.memoryRepository.logEvent({
      auth: input.auth,
      action: "delete",
      memoryId: input.memoryId,
      ipHash: this.deps.ipHash(input.requesterIp),
    }).catch((error) => {
      this.deps.noteMemoryDbFailure(error, "delete-log");
    });

    this.deps.invalidateRecallCache(input.auth);
    this.deps.invalidateRecallV2Cache(input.auth);
    void this.deps.bumpRecallStamp(input.auth).catch(() => {});
    void this.deps.markSnapshotStale(input.auth).catch(() => {});
    void this.deps.queueSnapshotRefresh(input.auth, "delete_memory", 1_000).catch(() => {});
  }
}
