import type { AuthContext } from "../../domain/auth/index.js";

export interface ListedMemory {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ListMemoriesUseCaseInput {
  limit?: number;
  offset?: number;
  includeTotal?: boolean;
}

export interface ListedMemoriesPage {
  memories: ListedMemory[];
  limit: number;
  offset: number;
  total: number | null;
  hasMore: boolean;
}

interface ListMemoriesUseCaseDeps {
  readonly memoryRepository: {
    list(auth: AuthContext, limit?: number, options?: { offset?: number }): Promise<Array<{
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
    count(auth: AuthContext): Promise<number>;
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

function normalizeStoredMemoryText(text: string): string {
  const rawIdx = text.indexOf("\nRaw:");
  if (rawIdx >= 0) {
    return text.slice(rawIdx + "\nRaw:".length).trim();
  }
  return text.trim();
}

export class ListMemoriesUseCase {
  private readonly deps: ListMemoriesUseCaseDeps;

  constructor(deps: ListMemoriesUseCaseDeps) {
    this.deps = deps;
  }

  async execute(auth: AuthContext, input: ListMemoriesUseCaseInput = {}): Promise<ListedMemoriesPage> {
    const requestedLimit = typeof input.limit === "number" ? input.limit : 200;
    const requestedOffset = typeof input.offset === "number" ? input.offset : 0;
    const limit = Math.max(1, Math.min(200, Math.trunc(requestedLimit)));
    const offset = Math.max(0, Math.trunc(requestedOffset));
    const includeTotal = input.includeTotal ?? false;

    const rows = await this.deps.memoryRepository.list(auth, limit, { offset });

    const memories = rows.map((row) => {
      let text = "";
      try {
        text = normalizeStoredMemoryText(this.deps.decryptMemoryContent(row.content_ciphertext));
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

    const total = includeTotal ? await this.deps.memoryRepository.count(auth) : null;
    const hasMore = total !== null ? offset + memories.length < total : memories.length === limit;

    void this.deps.memoryRepository.logEvent({
      auth,
      action: "list",
      metadata: {
        count: memories.length,
        limit,
        offset,
        ...(total !== null ? { total } : {}),
      },
    }).catch((error) => {
      this.deps.noteMemoryDbFailure(error, "list-log");
    });

    return {
      memories,
      limit,
      offset,
      total,
      hasMore,
    };
  }
}
