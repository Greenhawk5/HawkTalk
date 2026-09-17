import type { ConversationRow, MessageRow } from './conversation-types';
import type { ConversationRepository } from './conversation-repository';
import { requireId, requireLimit, requireMessage, requireUserId, repositoryCall } from '../conversation/validation';

function isConversationRow(value: unknown): value is ConversationRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['id'] === 'string' &&
    typeof row['user_id'] === 'number' &&
    typeof row['title'] === 'string' &&
    (row['status'] === 'active' || row['status'] === 'archived') &&
    typeof row['created_at'] === 'string' &&
    typeof row['updated_at'] === 'string'
  );
}

function isMessageRow(value: unknown): value is MessageRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['id'] === 'string' &&
    typeof row['conversation_id'] === 'string' &&
    typeof row['user_id'] === 'number' &&
    typeof row['seq'] === 'number' &&
    (row['role'] === 'system' || row['role'] === 'user' || row['role'] === 'assistant') &&
    typeof row['content'] === 'string' &&
    typeof row['created_at'] === 'string'
  );
}

export class D1ConversationRepository implements ConversationRepository {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async createConversation(input: { userId: number; id: string; title: string; timestamp?: string }): Promise<ConversationRow | null> {
    const ts = input.timestamp ?? new Date().toISOString();
    try {
      await this.db
        .prepare('INSERT INTO conversations (id, user_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(input.id, input.userId, input.title, 'active', ts, ts)
        .run();
    } catch {
      return null;
    }
    const row = await this.db.prepare('SELECT id, user_id, title, status, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?').bind(input.id, input.userId).first();
    return isConversationRow(row) ? row : null;
  }

  async getConversation(userId: number, conversationId: string): Promise<ConversationRow | null> {
    const row = await this.db
      .prepare('SELECT id, user_id, title, status, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?')
      .bind(conversationId, userId)
      .first();
    return isConversationRow(row) ? row : null;
  }

  async listConversations(userId: number, limit: number): Promise<ConversationRow[]> {
    const result = await this.db
      .prepare('SELECT id, user_id, title, status, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, id ASC LIMIT ?')
      .bind(userId, limit)
      .all();
    return result.results.filter(isConversationRow) as unknown as ConversationRow[];
  }

  async renameConversation(userId: number, conversationId: string, title: string, timestamp: string): Promise<ConversationRow | null> {
    return this.db
      .prepare('UPDATE conversations SET title = ?, updated_at = max(updated_at, ?) WHERE id = ? AND user_id = ? RETURNING id, user_id, title, status, created_at, updated_at')
      .bind(title, timestamp, conversationId, userId)
      .first<ConversationRow>();
  }

  async archiveConversation(userId: number, conversationId: string, timestamp: string): Promise<ConversationRow | null> {
    return this.db
      .prepare("UPDATE conversations SET status = 'archived', updated_at = max(updated_at, ?) WHERE id = ? AND user_id = ? RETURNING id, user_id, title, status, created_at, updated_at")
      .bind(timestamp, conversationId, userId)
      .first<ConversationRow>();
  }

  async deleteConversation(userId: number, conversationId: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
      .bind(conversationId, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async getConversationHistory(userId: number, conversationId: string, limit: number): Promise<MessageRow[]> {
    requireUserId(userId);
    requireId(conversationId);
    const historyLimit = requireLimit(limit);
    const conversation = await this.getConversation(userId, conversationId);
    if (conversation === null) return [];
    const result = await this.db
      .prepare('SELECT id, conversation_id, user_id, seq, role, content, created_at FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY seq DESC LIMIT ?')
      .bind(conversationId, userId, historyLimit)
      .all();
    return result.results.filter(isMessageRow).reverse() as unknown as MessageRow[];
  }

  async appendMessage(
    userId: number,
    conversationId: string,
    input: { id: string; role: 'system' | 'user' | 'assistant'; content: string; timestamp?: string },
  ): Promise<MessageRow | null> {
    requireUserId(userId);
    requireId(conversationId);
    const id = requireId(input.id);
    const now = input.timestamp ?? new Date().toISOString();
    const message = requireMessage(input, ['id', 'role', 'content', 'timestamp']);
    return repositoryCall(async () => {
      const row = await this.db.prepare(
        `INSERT INTO messages (id, conversation_id, user_id, seq, role, content, created_at)
         SELECT ?, id, user_id, last_seq + 1, ?, ?, max(updated_at, ?)
         FROM conversations WHERE id = ? AND user_id = ? AND status = 'active'
         RETURNING id, conversation_id, user_id, seq, role, content, created_at`,
      ).bind(id, message.role, message.content, now, conversationId, userId).first<MessageRow>();
      return row === null ? null : { ...row };
    });
  }

  async getMessage(userId: number, conversationId: string, messageId: string): Promise<MessageRow | null> {
    requireUserId(userId);
    requireId(conversationId);
    requireId(messageId);
    const row = await this.db
      .prepare('SELECT id, conversation_id, user_id, seq, role, content, created_at FROM messages WHERE id = ? AND conversation_id = ? AND user_id = ?')
      .bind(messageId, conversationId, userId)
      .first<Record<string, unknown>>();
    return isMessageRow(row) ? row : null;
  }

  async deleteMessage(userId: number, conversationId: string, messageId: string): Promise<boolean> {
    const conversation = await this.getConversation(userId, conversationId);
    if (conversation === null) return false;
    const result = await this.db
      .prepare('DELETE FROM messages WHERE id = ? AND conversation_id = ? AND user_id = ?')
      .bind(messageId, conversationId, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}