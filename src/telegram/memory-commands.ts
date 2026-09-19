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
        return { text: 'Usage: /remember <text to remember>' };
      }
      try {
        await service.store(userId, parsed.arg);
        return { text: 'Saved.' };
      } catch (err) {
        if (err && typeof err === 'object' && 'kind' in err) {
          const kind = (err as { kind: string }).kind;
          if (kind === 'capacity') return { text: 'Memory limit reached. Use /forget to remove old memories first.' };
          if (kind === 'invalid') return { text: 'Memory content must be between 2 and 2000 characters.' };
        }
        return { text: 'Could not save memory. Try again later.' };
      }
    }
    case '/memories': {
      try {
        const list = await service.list(userId, 20);
        if (list.length === 0) return { text: 'No memories stored.' };
        const lines = list.map((m, i) => `${i + 1}. ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`);
        const body = lines.join('\n');
        return { text: body.length > 4000 ? body.slice(0, 3999) + '…' : body };
      } catch {
        return { text: 'Could not retrieve memories. Try again later.' };
      }
    }
    case '/forget': {
      if (parsed.arg.length === 0) {
        try {
          const count = await service.clear(userId);
          return { text: count === 0 ? 'No memories to clear.' : `Cleared ${count} memories.` };
        } catch {
          return { text: 'Could not clear memories. Try again later.' };
        }
      }
      return { text: 'Usage: /forget (clears all memories). To store: /remember <text>' };
    }
    default:
      return { text: 'Unknown memory command.' };
  }
}
