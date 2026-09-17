import type { ConversationRow, MessageRow } from './conversation-types';

export interface ConversationRepository {
  createConversation(input: { userId: number; id: string; title: string; timestamp?: string }): Promise<ConversationRow | null>;
  getConversation(userId: number, conversationId: string): Promise<ConversationRow | null>;
  listConversations(userId: number, limit: number): Promise<ConversationRow[]>;
  renameConversation(userId: number, conversationId: string, title: string, timestamp: string): Promise<ConversationRow | null>;
  archiveConversation(userId: number, conversationId: string, timestamp: string): Promise<ConversationRow | null>;
  deleteConversation(userId: number, conversationId: string): Promise<boolean>;
  getConversationHistory(userId: number, conversationId: string, limit: number): Promise<MessageRow[]>;
  appendMessage(userId: number, conversationId: string, input: { id: string; role: 'system' | 'user' | 'assistant'; content: string; timestamp?: string }): Promise<MessageRow | null>;
  deleteMessage(userId: number, conversationId: string, messageId: string): Promise<boolean>;
}

export type { ConversationRow, MessageRow } from './conversation-types';