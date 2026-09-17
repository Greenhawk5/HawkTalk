import type { ProcessingRecord, ProcessingRepository, ProcessingState } from './types';

// D1-backed durable processing state for Telegram updates (Phase 6).
//
// State machine (per update_id, enforced atomically in SQL):
//   claimed → generating → completed | failed
//
// - 'claimed': webhook claimed the update (Phase 2 claim); no conversation work yet.
// - 'generating': conversation resolved, user message persisted, AI invocation
//   about to start (or possibly started and outcome uncertain). Transition is
//   one-way: after this, redelivery NEVER regenerates — it either reuses the
//   persisted assistant message ('completed') or answers nothing ('failed').
// - 'completed': assistant message persisted; assistant_message_id is the
//   durable result any retry reuses for delivery.
// - 'failed': AI generation failed after starting. Terminal: redelivery
//   acknowledges the update without another AI attempt (approved policy).
//
// All statements are prepared, parameterized, and scoped by update_id. No
// in-memory state participates in correctness.

function isProcessingState(value: unknown): value is ProcessingState {
  return value === 'claimed' || value === 'generating' || value === 'completed' || value === 'failed';
}

function toRecord(row: Record<string, unknown> | null): ProcessingRecord | null {
  if (row === null) return null;
  const state = row['processing_state'];
  if (typeof state !== 'string' || !isProcessingState(state)) return null;
  const conversationId = row['conversation_id'];
  const assistantMessageId = row['assistant_message_id'];
  return {
    updateId: typeof row['update_id'] === 'number' ? row['update_id'] : -1,
    state,
    conversationId: typeof conversationId === 'string' ? conversationId : null,
    assistantMessageId: typeof assistantMessageId === 'string' ? assistantMessageId : null,
  };
}

export class D1ProcessingRepository implements ProcessingRepository {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async markGenerating(updateId: number, conversationId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE processed_updates SET processing_state = 'generating', conversation_id = ?
         WHERE update_id = ? AND processing_state = 'claimed'`,
      )
      .bind(conversationId, updateId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async completeWithAssistantMessage(updateId: number, assistantMessageId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE processed_updates SET processing_state = 'completed', assistant_message_id = ?
         WHERE update_id = ? AND processing_state = 'generating'`,
      )
      .bind(assistantMessageId, updateId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async markFailed(updateId: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE processed_updates SET processing_state = 'failed'
         WHERE update_id = ? AND processing_state = 'generating'`,
      )
      .bind(updateId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async getProcessingRecord(updateId: number): Promise<ProcessingRecord | null> {
    const row = await this.db
      .prepare('SELECT update_id, processing_state, conversation_id, assistant_message_id FROM processed_updates WHERE update_id = ?')
      .bind(updateId)
      .first<Record<string, unknown>>();
    return toRecord(row);
  }
}
