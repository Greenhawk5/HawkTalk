// Phase 10 user-facing routing commands (Telegram-native, transport-level).
// Explicit, allowlisted profile selection for the conversational flow:
//   /fast <question>     → FAST profile (cheapest enabled provider)
//   /smart <question>    → COMPLEX profile (strongest provider, longer budget)
//   /research <question> → RESEARCH profile (web tools enabled)
// Plain text (or an omitted command) uses DEFAULT. Anything else — including
// near-misses like `/faster` or `/research please explain` without the exact
// space-separated form — is ordinary conversational text, never a profile.
// Matching is case-sensitive on the trimmed message; the query remainder is
// bounded and passed to the flow as the user message (the command prefix is
// stripped so it never reaches the model or history).

import type { RoutingProfile } from '../ai/routing-profiles';

export const MODE_COMMANDS: Readonly<Record<string, RoutingProfile>> = {
  '/fast': 'FAST',
  '/smart': 'COMPLEX',
  '/research': 'RESEARCH',
};

export const MAX_COMMAND_QUERY_CHARS = 4000;

export interface UserModeCommand {
  profile: RoutingProfile;
  /** Stripped remainder; empty when the command was sent without a question. */
  query: string;
}

export function parseUserCommand(text: string): UserModeCommand | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  for (const command of Object.keys(MODE_COMMANDS)) {
    if (trimmed === command) return { profile: MODE_COMMANDS[command] as RoutingProfile, query: '' };
    if (trimmed.startsWith(`${command} `)) {
      const query = trimmed.slice(command.length + 1).trim().slice(0, MAX_COMMAND_QUERY_CHARS);
      return { profile: MODE_COMMANDS[command] as RoutingProfile, query };
    }
  }
  return null;
}

export const MODE_COMMAND_USAGE_HINT =
  '⚡ Quick tip: send a mode together with your question.\n\n/fast <question> — quick answer\n/smart <question> — deeper reasoning\n/research <question> — web research';
