import type { ConversationRow, MessageRow } from '../db/conversation-types';

// Phase 6 application orchestration: connects Telegram transport, conversation
// memory, Agent Core, and the AI Router into one conversational path. This layer
// coordinates only; it owns no parsing, no provider selection, and no Telegram
// retry policy of its own.
//
// Durable idempotency policy (approved):
// - Each Telegram update gets a durable processing state row before any AI work.
// - Once a generation attempt has started for an update, that update is never
//   automatically regenerated after a crash, timeout, or uncertain outcome.
// - A persisted assistant response is reused on redelivery; the AI is not
//   called again for the same update.
// - Telegram sendMessage is at-least-once: duplicates can reach the user even
//   though generation and persistence are idempotent. This is documented as an
//   unavoidable limitation.

export type ProcessingState = 'claimed' | 'generating' | 'completed' | 'failed';

export interface ProcessingRepository {
  /** Marks an already-claimed update as generating. Returns false when the update is not in a claimable/pre-generation state. */
  markGenerating(updateId: number, conversationId: string): Promise<boolean>;
  /** Records the persisted assistant message and completes processing. Returns false when no generating row exists. */
  completeWithAssistantMessage(updateId: number, assistantMessageId: string): Promise<boolean>;
  /** Marks a failed generation so redelivery never regenerates. Returns false when no generating row exists. */
  markFailed(updateId: number): Promise<boolean>;
  /** Returns the current durable processing record for an update, or null. */
  getProcessingRecord(updateId: number): Promise<ProcessingRecord | null>;
}

export interface ProcessingRecord {
  updateId: number;
  state: ProcessingState;
  conversationId: string | null;
  assistantMessageId: string | null;
}

export interface DefaultConversationResolution {
  conversation: ConversationRow;
  /** True when the conversation was created during this resolution. */
  created: boolean;
}

export interface ConversationOrchestrator {
  /** Resolves or atomically creates the owner's default active conversation. */
  resolveDefaultConversation(userId: number): Promise<DefaultConversationResolution>;
  /** Appends a message with the orchestrator's injected clock. */
  appendMessage(userId: number, conversationId: string, input: { role: 'system' | 'user' | 'assistant'; content: string }): Promise<MessageRow>;
  /** Loads bounded newest-first history as provider-neutral messages. */
  getContext(userId: number, conversationId: string, limit: number): Promise<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>>;
  /** Owner-scoped lookup of one persisted message's text; null when absent/foreign. */
  getMessageText(userId: number, conversationId: string, messageId: string): Promise<string | null>;
}
