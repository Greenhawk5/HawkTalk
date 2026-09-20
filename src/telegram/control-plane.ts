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
    let message = [
      '👋 Hey, welcome to HawkTalk!',
      '',
      "I'm your AI assistant for:",
      '• 💬 Everyday questions',
      '• 🧠 Brainstorming & working through ideas',
      '• 💻 Coding help',
      '• 🔎 Research',
      '• 📝 Writing',
      '',
      'Just send me a message — no setup needed. What are you working on? 🙂',
    ].join('\n');
    if (isAdmin) {
      message += '\n\n🛠 You have admin access — /admin opens the admin panel.';
    }
    return { text: message };
  }

  if (trimmed === HELP_COMMAND) {
    const lines = [
      '❓ HawkTalk help',
      '',
      'Talk to me naturally — no commands needed for everyday chat.',
      '👋 /start — what HawkTalk can do',
      '❓ /help — this list',
      '',
      '⚡ /fast <question> — quick, lightweight answers',
      '🧠 /smart <question> — deeper, more careful reasoning',
      '🔎 /research <question> — web-assisted research',
      '',
      '🧷 /remember <text> — save something for later',
      '📋 /memories — see what I remember',
      '🧹 /forget — clear your memories',
      '',
      'Tips:',
      '• Send a mode command together with your question.',
      '• I stay concise unless you ask for detail.',
    ];
    if (isAdmin) {
      lines.push('', '🛠 /admin — open the admin panel');
    }
    return { text: lines.join('\n') };
  }

  return { text: '🤔 Not sure what that means. Try /help to see what I can do.' };
}