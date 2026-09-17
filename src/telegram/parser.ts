import type { ParsedTelegramUpdate } from './types';

// Parses an untrusted Telegram webhook JSON payload.
// Returns null when the payload has no usable update_id (caller: reject with 400).
// Any payload WITH a valid update_id is owned by us afterwards: unsupported
// content is acknowledged (200), never rejected, so Telegram stops retrying it.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeIntegerId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseTelegramUpdate(payload: unknown): ParsedTelegramUpdate | null {
  if (!isRecord(payload)) return null;
  if (!isSafeIntegerId(payload['update_id'])) return null;
  const updateId = payload['update_id'];

  const message = payload['message'];
  if (isRecord(message)) {
    const from = message['from'];
    const chat = message['chat'];
    const text = message['text'];
    if (
      isRecord(from) &&
      typeof from['id'] === 'number' &&
      Number.isInteger(from['id']) &&
      (from['id'] as number) > 0 &&
      isRecord(chat) &&
      typeof chat['id'] === 'number' &&
      Number.isInteger(chat['id'] as number) &&
      typeof text === 'string'
    ) {
      const firstName = optionalText(from['first_name']);
      const lastName = optionalText(from['last_name']);
      const displayName = [firstName, lastName].filter((part): part is string => part !== null).join(' ') || null;
      return {
        kind: 'text_message',
        updateId,
        userId: from['id'] as number,
        chatId: chat['id'] as number,
        text,
        username: optionalText(from['username']),
        displayName,
      };
    }
  }

  return { kind: 'unsupported', updateId };
}
