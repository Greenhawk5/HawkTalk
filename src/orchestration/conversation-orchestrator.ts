import type { ConversationRepository } from '../db/conversation-repository';
import type { ConversationRow, MessageRow } from '../db/conversation-types';
import { ConversationService, MAX_HISTORY_MESSAGES } from '../conversation/service';
import type { Clock } from '../conversation/clock';
import type { ConversationOrchestrator, DefaultConversationResolution } from './types';

// Default conversation resolution (Phase 6, approved strategy):
// - Each internal user has at most one durable default mapping (default_conversations).
// - Resolution reuses the mapped conversation when it exists and is 'active'.
// - If the mapping is missing, or points at a conversation that is archived or
//   deleted, a new conversation is created and (re)bound as the default.
// - The bind is a single guarded upsert: it only writes when no active mapping
//   exists, so a concurrent resolution cannot steal an already-active default.
//   Under a rare race both writers create user-owned active conversations and
//   one mapping wins; the loser is a harmless orphan owned by the same user.
// - Telegram chat IDs are never used as conversation identifiers; ownership is
//   the internal users.id only. No one-active-conversation restriction is
//   imposed on the Phase 5 model — other conversations may exist untouched.

export const DEFAULT_CONVERSATION_TITLE = 'Default conversation';

export class D1ConversationOrchestrator implements ConversationOrchestrator {
  private readonly db: D1Database;
  private readonly service: ConversationService;

  constructor(db: D1Database, repository: ConversationRepository, clock?: Clock) {
    this.db = db;
    this.service = new ConversationService(repository, clock);
  }

  async resolveDefaultConversation(userId: number): Promise<DefaultConversationResolution> {
    const mapped = await this.readMappedConversation(userId);
    if (mapped !== null) return { conversation: mapped, created: false };
    const conversation = await this.service.createConversation(userId, DEFAULT_CONVERSATION_TITLE);
    await this.bindDefault(userId, conversation.id);
    const rebound = await this.readMappedConversation(userId);
    if (rebound !== null) return { conversation: rebound, created: rebound.id === conversation.id };
    return { conversation, created: true };
  }

  private async readMappedConversation(userId: number): Promise<ConversationRow | null> {
    const row = await this.db
      .prepare(
        `SELECT c.id, c.user_id, c.title, c.status, c.created_at, c.updated_at
         FROM default_conversations d JOIN conversations c ON c.id = d.conversation_id AND c.user_id = d.user_id
         WHERE d.user_id = ? AND c.status = 'active'`,
      )
      .bind(userId)
      .first<Record<string, unknown>>();
    if (row === null) return null;
    return {
      id: String(row['id']),
      user_id: Number(row['user_id']),
      title: String(row['title']),
      status: 'active',
      created_at: String(row['created_at']),
      updated_at: String(row['updated_at']),
    };
  }

  /** Guarded upsert: writes only when the user has no active mapped conversation. */
  private async bindDefault(userId: number, conversationId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO default_conversations (user_id, conversation_id)
         SELECT ?, ? WHERE NOT EXISTS (
           SELECT 1 FROM default_conversations d
           JOIN conversations c ON c.id = d.conversation_id
           WHERE d.user_id = ? AND c.status = 'active'
         )
         ON CONFLICT (user_id) DO UPDATE SET conversation_id = excluded.conversation_id`,
      )
      .bind(userId, conversationId, userId)
      .run();
  }

  async appendMessage(userId: number, conversationId: string, input: { role: 'system' | 'user' | 'assistant'; content: string }): Promise<MessageRow> {
    return this.service.appendMessage(userId, conversationId, input);
  }

  async getContext(userId: number, conversationId: string, limit: number): Promise<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>> {
    const bounded = Math.min(Math.max(1, limit), MAX_HISTORY_MESSAGES);
    return this.service.getContext(userId, conversationId, bounded);
  }

  async getMessageText(userId: number, conversationId: string, messageId: string): Promise<string | null> {
    const row = await this.service.getMessageText(userId, conversationId, messageId);
    return row;
  }
}
