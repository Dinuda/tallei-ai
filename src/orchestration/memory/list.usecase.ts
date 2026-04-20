import type { AuthContext } from "../../domain/auth/index.js";

export interface ListedMemory {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface ListMemoriesUseCaseDeps {
  readonly memoryRepository: {
    list(auth: AuthContext, limit?: number): Promise<Array<{
      id: string;
      content_ciphertext: string;
      summary_json: unknown;
      platform: string;
      memory_type: string;
      category: string | null;
      is_pinned: boolean;
      reference_count: number;
      created_at: string;
    }>>;
    logEvent(input: {
      auth: AuthContext;
      action: string;
      memoryId?: string;
      ipHash?: string | null;
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  readonly decryptMemoryContent: (ciphertext: string) => string;
  readonly noteMemoryDbFailure: (error: unknown, context: string) => void;
}

export class ListMemoriesUseCase {
  private readonly deps: ListMemoriesUseCaseDeps;

  constructor(deps: ListMemoriesUseCaseDeps) {
    this.deps = deps;
  }

  async execute(auth: AuthContext): Promise<ListedMemory[]> {
    const rows = await this.deps.memoryRepository.list(auth, 200);

    const memories = rows.map((row) => {
      let text = "";
      try {
        text = this.deps.decryptMemoryContent(row.content_ciphertext);
      } catch {
        text = "[Encrypted memory unavailable]";
      }

      const metadata = (row.summary_json && typeof row.summary_json === "object"
        ? (row.summary_json as Record<string, unknown>)
        : {}) as Record<string, unknown>;

      return {
        id: row.id,
        text,
        metadata: {
          ...metadata,
          platform: row.platform,
          memory_type: row.memory_type,
          category: row.category,
          is_pinned: row.is_pinned,
          reference_count: row.reference_count,
        },
        createdAt: row.created_at,
      };
    });

    void this.deps.memoryRepository.logEvent({
      auth,
      action: "list",
      metadata: { count: memories.length },
    }).catch((error) => {
      this.deps.noteMemoryDbFailure(error, "list-log");
    });

    return memories;
  }
}
