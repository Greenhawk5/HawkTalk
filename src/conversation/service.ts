import { ConversationServiceError, exactObject, isUuidV4, requireId, requireLimit, requireMessage, requireTitle, requireUserId, repositoryCall } from './validation';
import { MAX_MESSAGE_CHARS } from '../agent/types';
import type { AgentMessage } from '../agent/types';
import type { ConversationRepository } from '../db/conversation-repository';
import type { ConversationRow, MessageRow } from '../db/conversation-types';
import type { Clock } from './clock';
import { RuntimeClock } from './clock';

export { ConversationServiceError } from './validation';

export const MAX_LIST_PAGE_SIZE = 100;
export const MAX_HISTORY_MESSAGES = 100;
export const MAX_HISTORY_MESSAGE_CHARS = MAX_MESSAGE_CHARS;
export const MAX_HISTORY_TOTAL_CHARS = 100_000;

export function generateConversationId(): string {
  return crypto.randomUUID();
}

export function generateMessageId(): string {
  return crypto.randomUUID();
}

function failNotFound(): never {
  throw new ConversationServiceError('not_found');
}

export class ConversationService {
  private readonly repository: ConversationRepository;
  private readonly clock: Clock;

  constructor(repository: ConversationRepository, clock?: Clock) {
    this.repository = repository;
    this.clock = clock ?? new RuntimeClock();
  }

  async createConversation(userId: unknown, title: unknown): Promise<ConversationRow> {
    const owner = requireUserId(userId);
    const titleChars = requireTitle(title);
    const timestamp = this.clock.now();
    return repositoryCall(async () => {
      const row = await this.repository.createConversation({ userId: owner, id: generateConversationId(), title: titleChars, timestamp });
      if (row === null) throw new ConversationServiceError('conflict');
      return row;
    });
  }

  async getConversation(userId: unknown, conversationId: unknown): Promise<ConversationRow> {
    const owner = requireUserId(userId);
    const id = requireId(conversationId);
    return repositoryCall(async () => {
      const row = await this.repository.getConversation(owner, id);
      if (row === null) failNotFound();
      return row;
    });
  }

  async listConversations(userId: unknown, limit: unknown): Promise<ConversationRow[]> {
    const owner = requireUserId(userId);
    const pageSize = requireLimit(limit);
    return repositoryCall(() => this.repository.listConversations(owner, pageSize));
  }

  async renameConversation(userId: unknown, conversationId: unknown, title: unknown): Promise<ConversationRow> {
    const owner = requireUserId(userId);
    const id = requireId(conversationId);
    const titleChars = requireTitle(title);
    const timestamp = this.clock.now();
    return repositoryCall(async () => {
      const row = await this.repository.renameConversation(owner, id, titleChars, timestamp);
      if (row === null) failNotFound();
      return row;
    });
  }

  async archiveConversation(userId: unknown, conversationId: unknown): Promise<ConversationRow> {
    const owner = requireUserId(userId);
    const id = requireId(conversationId);
    const timestamp = this.clock.now();
    return repositoryCall(async () => {
      const row = await this.repository.archiveConversation(owner, id, timestamp);
      if (row === null) failNotFound();
      return row;
    });
  }

  async deleteConversation(userId: unknown, conversationId: unknown): Promise<boolean> {
    const owner = requireUserId(userId);
    const id = requireId(conversationId);
    return repositoryCall(() => this.repository.deleteConversation(owner, id));
  }

  async getHistory(userId: unknown, conversationId: unknown, limit: unknown): Promise<MessageRow[]> {
    const owner = requireUserId(userId);
    const id = requireId(conversationId);
    const historyLimit = requireLimit(limit);
    return repositoryCall(async () => {
      const messages = await this.repository.getConversationHistory(owner, id, historyLimit);
      let total = 0;
      const newestFirst: MessageRow[] = [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message === undefined) break;
        if (message.content.length > MAX_HISTORY_MESSAGE_CHARS || total + message.content.length > MAX_HISTORY_TOTAL_CHARS) break;
        total += message.content.length;
        newestFirst.push(message);
      }
      return newestFirst.reverse();
    });
  }

  async getContext(userId: unknown, conversationId: unknown, limit: unknown): Promise<AgentMessage[]> {
    const history = await this.getHistory(userId, conversationId, limit);
    return history.map((message) => ({ role: message.role, content: message.content }));
  }

  async appendMessage(userId: unknown, conversationId: unknown, input: unknown): Promise<MessageRow> {
    const owner = requireUserId(userId);
    const id = requireId(conversationId);
    const timestamp = this.clock.now();
    const fields = exactObject(input, ['role', 'content']);
    const message = requireMessage(fields);
    return repositoryCall(async () => {
      const row = await this.repository.appendMessage(owner, id, { id: generateMessageId(), role: message.role, content: message.content, timestamp });
      if (row === null) failNotFound();
      return row;
    });
  }

  async deleteMessage(userId: unknown, conversationId: unknown, messageId: unknown): Promise<boolean> {
    const owner = requireUserId(userId);
    const conversation = requireId(conversationId);
    const message = requireId(messageId);
    return repositoryCall(() => this.repository.deleteMessage(owner, conversation, message));
  }
}

export { isUuidV4 };