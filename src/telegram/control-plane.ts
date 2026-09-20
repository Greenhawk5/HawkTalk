// Deterministic control-plane commands: /start and /help.
// These execute without any AI provider, API key, or conversational flow.

import { getTelegramUserRole } from '../db/telegram';

export const START_COMMAND = '/start';
export const HELP_COMMAND = '/help';

export function isControlPlaneCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === START_COMMAND || trimmed === HELP_COMMAND;
}

export interface ControlPlaneResult {
  text: string;
  keyboard?: Array<Array<{ text: string; callback_data: string }>>;
}

export async function handleControlPlaneCommand(
  db: D1Database,
  telegramUserId: number,
  text: string,
): Promise<ControlPlaneResult> {
  const trimmed = text.trim();
  const role = await getTelegramUserRole(db, telegramUserId).catch(() => null);
  const isAdmin = role === 'OWNER' || role === 'ADMIN';

  if (trimmed === START_COMMAND) {
    let message = 'Welcome to HawkTalk! Send me a message and I will do my best to help you.';
    if (isAdmin) {
      message += '\n\nYou have admin privileges. Use /admin to open the Admin Panel.';
    }
    return { text: message };
  }

  if (trimmed === HELP_COMMAND) {
    const lines = [
      'HawkTalk Help',
      '',
      '/start - Welcome message',
      '/help - Show this help',
      '/fast <question> - Quick response',
      '/smart <question> - Detailed response',
      '/research <question> - Web research',
      '/remember <text> - Save a memory',
      '/memories - List memories',
      '/forget - Clear memories',
    ];
    if (isAdmin) {
      lines.push('/admin - Open Admin Panel');
    }
    return { text: lines.join('\n') };
  }

  return { text: 'Unknown command.' };
}