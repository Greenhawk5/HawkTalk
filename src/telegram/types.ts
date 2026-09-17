// Telegram transport types (Phase 2).
// Transport-only shapes: no AI, quota, or memory concepts live here.

/** Result of validating an incoming webhook JSON payload. */
export type ParsedTelegramUpdate =
  | {
      kind: 'text_message';
      updateId: number;
      userId: number;
      chatId: number;
      /** Telegram chat type ('private' | 'group' | 'supergroup' | 'channel' | unknown). */
      chatType: string;
      text: string;
      username: string | null;
      displayName: string | null;
    }
  | {
      kind: 'unsupported';
      updateId: number;
    };

/** Minimal subset of the Bot API sendMessage response we rely on. */
export interface TelegramApiResponse {
  ok: boolean;
}
