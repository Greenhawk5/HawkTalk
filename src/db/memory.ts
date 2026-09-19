// Phase 10 semantic-memory persistence (D1).
// Every statement is prepared, parameterized, and scoped by the internal
// users.id: a row owned by another user is indistinguishable from a missing
// row. No content is logged here, and no credential material lives in these
// tables (only the owner's own memory text — never secrets by policy).

import type {
  MemoryEmbeddingRecord,
  MemoryRecord,
  MemoryRepository,
  MemoryStatus,
  VectorState,
} from '../memory/ports';

function isStatus(value: unknown): value is MemoryStatus {
  return value === 'pending' || value === 'active' || value === 'failed';
}

function isVectorState(value: unknown): value is VectorState {
  return value === 'pending' || value === 'synced' || value === 'failed';
}

function toMemory(row: Record<string, unknown>): MemoryRecord | null {
  const status = row['status'];
  if (typeof status !== 'string' || !isStatus(status)) return null;
  return {
    id: String(row['id']),
    userId: Number(row['user_id']),
    content: String(row['content']),
    status,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function toEmbedding(row: Record<string, unknown>): MemoryEmbeddingRecord | null {
  const state = row['vector_state'];
  if (typeof state !== 'string' || !isVectorState(state)) return null;
  return {
    memoryId: String(row['memory_id']),
    vectorId: String(row['vector_id']),
    providerId: String(row['provider_id']),
    vendorModel: String(row['vendor_model']),
    dimensions: Number(row['dimensions']),
    vectorState: state,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export class D1MemoryRepository implements MemoryRepository {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async insertMemory(input: { id: string; userId: number; content: string; createdAt: string }): Promise<boolean> {
    try {
      const result = await this.db
        .prepare(
          `INSERT INTO memories (id, user_id, content, status, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(input.id, input.userId, input.content, input.createdAt, input.createdAt)
        .run();
      return (result.meta.changes ?? 0) > 0;
    } catch {
      // Includes the durable per-user capacity trigger; a false return means
      // nothing was stored, never a partially-written row.
      return false;
    }
  }

  async setMemoryStatus(userId: number, memoryId: string, status: MemoryStatus, updatedAt: string): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE memories SET status = ?, updated_at = max(updated_at, ?) WHERE id = ? AND user_id = ?')
      .bind(status, updatedAt, memoryId, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async upsertMemoryEmbedding(input: {
    memoryId: string;
    vectorId: string;
    providerId: string;
    vendorModel: string;
    dimensions: number;
    vectorState: VectorState;
    timestamp: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO memory_embeddings (memory_id, vector_id, provider_id, vendor_model, dimensions, vector_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (memory_id) DO UPDATE SET
           vector_id = excluded.vector_id,
           provider_id = excluded.provider_id,
           vendor_model = excluded.vendor_model,
           dimensions = excluded.dimensions,
           vector_state = excluded.vector_state,
           updated_at = max(memory_embeddings.updated_at, excluded.updated_at)`,
      )
      .bind(
        input.memoryId,
        input.vectorId,
        input.providerId,
        input.vendorModel,
        input.dimensions,
        input.vectorState,
        input.timestamp,
        input.timestamp,
      )
      .run();
  }

  async findMemory(userId: number, memoryId: string): Promise<{ memory: MemoryRecord; embedding: MemoryEmbeddingRecord | null } | null> {
    const row = await this.db
      .prepare(
        `SELECT m.id, m.user_id, m.content, m.status, m.created_at, m.updated_at,
                e.memory_id, e.vector_id, e.provider_id, e.vendor_model, e.dimensions, e.vector_state,
                e.created_at AS embedding_created_at, e.updated_at AS embedding_updated_at
         FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.id = ? AND m.user_id = ?`,
      )
      .bind(memoryId, userId)
      .first<Record<string, unknown>>();
    if (row === null) return null;
    const memory = toMemory(row);
    if (memory === null) return null;
    const embedding = row['vector_id'] === null || row['vector_id'] === undefined
      ? null
      : toEmbedding({
          memory_id: row['memory_id'],
          vector_id: row['vector_id'],
          provider_id: row['provider_id'],
          vendor_model: row['vendor_model'],
          dimensions: row['dimensions'],
          vector_state: row['vector_state'],
          created_at: row['embedding_created_at'],
          updated_at: row['embedding_updated_at'],
        });
    return { memory, embedding };
  }

  async findMemoriesByVectorIds(userId: number, vectorIds: readonly string[]): Promise<MemoryRecord[]> {
    const bounded = vectorIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 128).slice(0, 100);
    if (bounded.length === 0) return [];
    const placeholders = bounded.map(() => '?').join(', ');
    const result = await this.db
      .prepare(
        `SELECT m.id, m.user_id, m.content, m.status, m.created_at, m.updated_at
         FROM memories m
         JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.user_id = ? AND m.status = 'active' AND e.vector_state = 'synced'
           AND e.vector_id IN (${placeholders})`,
      )
      .bind(userId, ...bounded)
      .all<Record<string, unknown>>();
    const out: MemoryRecord[] = [];
    for (const row of result.results) {
      const memory = toMemory(row);
      if (memory !== null) out.push(memory);
    }
    return out;
  }

  async listMemories(userId: number, limit: number): Promise<MemoryRecord[]> {
    const pageSize = Math.min(Math.max(1, Math.floor(limit)), 100);
    const result = await this.db
      .prepare(
        `SELECT id, user_id, content, status, created_at, updated_at
         FROM memories WHERE user_id = ? ORDER BY created_at DESC, id ASC LIMIT ?`,
      )
      .bind(userId, pageSize)
      .all<Record<string, unknown>>();
    const out: MemoryRecord[] = [];
    for (const row of result.results) {
      const memory = toMemory(row);
      if (memory !== null) out.push(memory);
    }
    return out;
  }

  async deleteMemory(userId: number, memoryId: string): Promise<{ deleted: boolean; vectorId: string | null }> {
    const row = await this.db
      .prepare(
        `SELECT e.vector_id FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.id = ? AND m.user_id = ?`,
      )
      .bind(memoryId, userId)
      .first<Record<string, unknown>>();
    if (row === null) return { deleted: false, vectorId: null };
    const vectorId = typeof row['vector_id'] === 'string' ? row['vector_id'] : null;
    const result = await this.db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').bind(memoryId, userId).run();
    return { deleted: (result.meta.changes ?? 0) > 0, vectorId };
  }

  async countMemories(userId: number): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) AS count FROM memories WHERE user_id = ?').bind(userId).first<{ count: number }>();
    return row?.count ?? 0;
  }

  async clearMemories(userId: number): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `SELECT e.vector_id FROM memories m
         JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.user_id = ?`,
      )
      .bind(userId)
      .all<Record<string, unknown>>();
    const vectorIds: string[] = [];
    for (const row of rows.results) {
      if (typeof row['vector_id'] === 'string') vectorIds.push(row['vector_id']);
    }
    await this.db.prepare('DELETE FROM memories WHERE user_id = ?').bind(userId).run();
    return vectorIds;
  }
}
