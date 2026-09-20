// Phase 10: Telegram memory commands (/remember, /memories, /forget).
// Private-chat only, owner-scoped, authenticated. Parsed before the
// conversational flow so memory operations never reach the AI path.

import type { SemanticMemoryService } from '../memory/semantic-memory';

export const MEMORY_COMMANDS = ['/remember', '/memories', '/forget'] as const;

export interface MemoryCommandResult {
  text: string;
}

export function parseMemoryCommand(text: string): { command: string; arg: string } | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  for (const cmd of MEMORY_COMMANDS) {
    if (trimmed === cmd) return { command: cmd, arg: '' };
    if (trimmed.startsWith(`${cmd} `)) {
      return { command: cmd, arg: trimmed.slice(cmd.length + 1).trim() };
    }
  }
  return null;
}

export async function handleMemoryCommand(
  parsed: { command: string; arg: string },
  userId: number,
  service: SemanticMemoryService,
): Promise<MemoryCommandResult> {
  switch (parsed.command) {
    case '/remember': {
      if (parsed.arg.length === 0) {
        return { text: '📝 Usage: /remember <text>\nExample: /remember My thesis deadline is May 3.' };
      }
      try {
        await service.store(userId, parsed.arg);
        return { text: '✅ Got it — saved to memory.' };
      } catch (err) {
        if (err && typeof err === 'object' && 'kind' in err) {
          const kind = (err as { kind: string }).kind;
          if (kind === 'capacity') return { text: '🧠 Your memory is full. Clear some space with /forget, then try again.' };
          if (kind === 'invalid') return { text: '📝 Memories work best between 2 and 2000 characters.' };
        }
        return { text: '😕 Couldn’t save that memory. Please try again in a moment.' };
      }
    }
    case '/memories': {
      try {
        const list = await service.list(userId, 20);
        if (list.length === 0) return { text: '🧠 Nothing stored yet. Save your first memory with /remember <text>.' };
        const lines = list.map((m, i) => `${i + 1}. ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`);
        const body = `🧠 What I remember:\n\n${lines.join('\n')}`;
        return { text: body.length > 4000 ? body.slice(0, 3999) + '…' : body };
      } catch {
        return { text: '😕 Couldn’t pull up your memories. Please try again in a moment.' };
      }
    }
    case '/forget': {
      if (parsed.arg.length === 0) {
        try {
          const count = await service.clear(userId);
          return { text: count === 0 ? '🧠 Nothing to clear — memory is already empty.' : `🧹 Cleared ${count} ${count === 1 ? 'memory' : 'memories'}.` };
        } catch {
          return { text: '😕 Couldn’t clear memories. Please try again in a moment.' };
        }
      }
      return { text: '🧹 /forget clears all memories. To save instead: /remember <text>' };
    }
    default:
      return { text: '🤔 Unknown memory command. Try /remember, /memories, or /forget.' };
  }
}
