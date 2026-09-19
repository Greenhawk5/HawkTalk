// Phase 9 Telegram admin UI: parses admin commands/callbacks into structured
// intents, renders views, and drives the AdminService. Business logic lives
// entirely in AdminService; this file is presentation + input adaptation only.

import { adminErrorText, type AdminError } from '../admin/errors';

export const ADMIN_COMMAND = '/admin';
export const MAX_PAGE_CHARS = 3800;

/** Parsed admin command from a private-chat text message. */
export type AdminCommand =
  | { type: 'menu' }
  | { type: 'unknown'; text: string };

export function parseAdminCommand(text: string): AdminCommand | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === ADMIN_COMMAND) return { type: 'menu' };
  return null;
}

/**
 * Callback data grammar (allowlist, bounded): `a:<action>[:arg]`. Every part
 * is bounded; unknown actions parse to null and are rejected by the caller.
 * No secrets are ever encoded in callback data.
 */
export type AdminCallback =
  | { action: 'menu' }
  | { action: 'dashboard' }
  | { action: 'users'; cursor: number | null }
  | { action: 'user'; userId: number }
  | { action: 'policy'; role: string }
  | { action: 'providers' }
  | { action: 'provider'; providerId: string }
  | { action: 'audit'; cursor: number | null }
  | { action: 'tools' }
  | { action: 'credentials'; providerId: string }
  | { action: 'provtog'; providerId: string; enabled: boolean }
  | { action: 'credtog'; credentialId: string; enabled: boolean }
  | { action: 'credask'; credentialId: string }
  | { action: 'confirm'; confirmationId: string }
  | { action: 'urole'; userId: number; fromRole: string; toRole: string }
  | { action: 'ustat'; userId: number; nextStatus: 'active' | 'blocked' }
  | { action: 'usage' }
  | { action: 'routing' };

const CALLBACK_ACTIONS: ReadonlySet<string> = new Set(['menu', 'dashboard', 'users', 'user', 'policy', 'providers', 'provider', 'audit', 'tools', 'credentials', 'provtog', 'credtog', 'credask', 'confirm', 'urole', 'ustat', 'usage', 'routing']);
const SAFE_ID = /^[a-z0-9-]{1,64}$/;
const ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN', 'VIP', 'USER', 'BLOCKED']);
const STATUSES: ReadonlySet<string> = new Set(['active', 'blocked']);
const CONFIRMATION_ID = /^[a-f0-9]{32}$/;
const SAFE_NUMERIC = /^[1-9][0-9]*$/;

function numericArg(arg: string | undefined): number | null {
  if (arg === undefined || !SAFE_NUMERIC.test(arg) || !Number.isSafeInteger(Number(arg))) return null;
  return Number(arg);
}

export function parseAdminCallback(data: string): AdminCallback | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > 64 || !data.startsWith('a:')) return null;
  const parts = data.split(':');
  const action = parts[1];
  const arg = parts[2];
  if (action === undefined || !CALLBACK_ACTIONS.has(action)) return null;
  switch (action) {
    case 'menu':
    case 'dashboard':
    case 'providers':
    case 'tools':
    case 'usage':
    case 'routing':
      return parts.length === 2 ? { action } : null;
    case 'users':
    case 'audit': {
      if (parts.length === 2) return { action, cursor: null };
      if (parts.length !== 3) return null;
      const cursor = numericArg(arg);
      return cursor === null ? null : { action, cursor };
    }
    case 'user': {
      const userId = numericArg(arg);
      return parts.length === 3 && userId !== null ? { action, userId } : null;
    }
    case 'policy': {
      if (parts.length !== 3 || arg === undefined || !ROLES.has(arg)) return null;
      return { action, role: arg };
    }
    case 'provider': {
      if (parts.length !== 3 || arg === undefined || !SAFE_ID.test(arg)) return null;
      return { action, providerId: arg };
    }
    case 'credentials': {
      if (parts.length !== 3 || arg === undefined || !SAFE_ID.test(arg)) return null;
      return { action, providerId: arg };
    }
    case 'provtog':
    case 'credtog': {
      if (parts.length !== 4 || arg === undefined || !SAFE_ID.test(arg) || !STATUSES.has(parts[3] ?? '')) return null;
      const enabled = parts[3] === 'on';
      return action === 'provtog'
        ? { action, providerId: arg, enabled }
        : { action, credentialId: arg, enabled };
    }
    case 'credask': {
      if (parts.length !== 3 || arg === undefined || !SAFE_ID.test(arg)) return null;
      return { action, credentialId: arg };
    }
    case 'confirm': {
      if (parts.length !== 3 || arg === undefined || !CONFIRMATION_ID.test(arg)) return null;
      return { action, confirmationId: arg };
    }
    case 'urole': {
      if (parts.length !== 5) return null;
      const userId = numericArg(parts[2]);
      const fromRole = parts[3] ?? '';
      const toRole = parts[4] ?? '';
      if (userId === null || !ROLES.has(fromRole) || !ROLES.has(toRole)) return null;
      return { action, userId, fromRole, toRole };
    }
    case 'ustat': {
      if (parts.length !== 4) return null;
      const userId = numericArg(parts[2]);
      const nextStatus = parts[3] ?? '';
      if (userId === null || !STATUSES.has(nextStatus)) return null;
      return { action, userId, nextStatus: nextStatus as 'active' | 'blocked' };
    }
    default: return null;
  }
}

// --- rendering (plain text only; no HTML/Markdown injection surface) -----------

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface AdminView {
  text: string;
  keyboard: InlineButton[][];
}

function clamp(text: string): string {
  return text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}…` : text;
}

function backButton(): InlineButton {
  return { text: '← Back', callbackData: 'a:menu' };
}

export function renderMenu(): AdminView {
  return {
    text: 'HawkTalk Admin\n\nSelect a section:',
    keyboard: [
      [{ text: '📊 Dashboard', callbackData: 'a:dashboard' }],
      [{ text: '👥 Users', callbackData: 'a:users' }],
      [{ text: '🤖 Providers', callbackData: 'a:providers' }],
      [{ text: '📈 Quotas', callbackData: 'a:policy:USER' }],
      [{ text: '🛠 Tools', callbackData: 'a:tools' }],
      [{ text: '📋 Audit Logs', callbackData: 'a:audit' }],
      [{ text: '💰 Usage', callbackData: 'a:usage' }],
      [{ text: '🛰 Routing', callbackData: 'a:routing' }],
    ],
  };
}

export function renderDashboard(metrics: { totalUsers: number; usersByRole: Record<string, number>; providers: { total: number; enabled: number }; credentialCount: number; recentAudit: Array<{ action: string; success: boolean }> }): AdminView {
  const roles = Object.entries(metrics.usersByRole).map(([role, count]) => `${role}: ${count}`).join(', ');
  const recent = metrics.recentAudit.length > 0
    ? metrics.recentAudit.map((entry) => `${entry.success ? '✓' : '✗'} ${entry.action}`).join('\n')
    : 'No admin activity yet.';
  return {
    text: clamp(`📊 Dashboard\n\nUsers: ${metrics.totalUsers} (${roles})\nProviders: ${metrics.providers.enabled}/${metrics.providers.total} enabled\nCredentials: ${metrics.credentialCount}\n\nRecent admin activity:\n${recent}`),
    keyboard: [[backButton()]],
  };
}

export function renderUserList(users: Array<{ id: number; telegram_user_id: number; role: string; status: string }>, nextCursor: number | null): AdminView {
  const lines = users.map((user) => `#${user.id} tg:${user.telegram_user_id} ${user.role}${user.status !== 'active' ? ` (${user.status})` : ''}`);
  const keyboard: InlineButton[][] = users.slice(0, 10).map((user) => [{ text: `#${user.id} ${user.role}`, callbackData: `a:user:${user.id}` }]);
  if (nextCursor !== null) keyboard.push([{ text: 'Next →', callbackData: `a:users:${nextCursor}` }]);
  keyboard.push([backButton()]);
  return { text: clamp(`👥 Users\n\n${lines.length > 0 ? lines.join('\n') : 'No users.'}`), keyboard };
}

export function renderUserDetail(user: { id: number; telegram_user_id: number; username: string | null; display_name: string | null; role: string; status: string; created_at: string }): AdminView {
  const keyboard: InlineButton[][] = [];
  const roleRow: InlineButton[] = [];
  if (user.role !== 'USER') roleRow.push({ text: '→ USER', callbackData: `a:urole:${user.id}:${user.role}:USER` });
  if (user.role !== 'VIP') roleRow.push({ text: '→ VIP', callbackData: `a:urole:${user.id}:${user.role}:VIP` });
  if (user.role !== 'ADMIN') roleRow.push({ text: '→ ADMIN', callbackData: `a:urole:${user.id}:${user.role}:ADMIN` });
  if (roleRow.length > 0) keyboard.push(roleRow);
  keyboard.push([{ text: user.status === 'active' ? '🚫 Block' : '✅ Unblock', callbackData: `a:ustat:${user.id}:${user.status === 'active' ? 'blocked' : 'active'}` }]);
  keyboard.push([{ text: '← Users', callbackData: 'a:users' }]);
  return {
    text: clamp(`👤 User #${user.id}\nTelegram: ${user.telegram_user_id}\nName: ${user.display_name ?? '—'}\nUsername: ${user.username ?? '—'}\nRole: ${user.role}\nStatus: ${user.status}\nCreated: ${user.created_at}`),
    keyboard,
  };
}

export function renderProviderList(providers: Array<{ id: string; enabled: boolean; defaultModel: string; credentialCount: number }>): AdminView {
  const lines = providers.map((provider) => `${provider.enabled ? '🟢' : '🔴'} ${provider.id} (${provider.credentialCount} cred, ${provider.defaultModel})`);
  const keyboard: InlineButton[][] = providers.slice(0, 10).map((provider) => [{ text: `${provider.id}`, callbackData: `a:provider:${provider.id}` }]);
  keyboard.push([backButton()]);
  return {
    text: clamp(`🤖 Providers\n\n${lines.length > 0 ? lines.join('\n') : 'No providers configured.'}`),
    keyboard,
  };
}

export function renderProviderDetail(provider: { id: string; baseUrl: string; enabled: boolean; weight: number; defaultModel: string; timeoutMs: number; maxCredentialAttempts: number; credentials: Array<{ id: string; label: string; enabled: boolean; weight: number }> }, actorRole: string): AdminView {
  const keyboard: InlineButton[][] = [];
  keyboard.push([{ text: provider.enabled ? '⏸ Disable' : '▶ Enable', callbackData: `a:provtog:${provider.id}:${provider.enabled ? 'off' : 'on'}` }]);
  for (const credential of provider.credentials) {
    const row: InlineButton[] = [{ text: `${credential.enabled ? '⏸' : '▶'} ${credential.id}`, callbackData: `a:credtog:${credential.id}:${credential.enabled ? 'off' : 'on'}` }];
    if (actorRole === 'OWNER') row.push({ text: '🗑 Delete', callbackData: `a:credask:${credential.id}` });
    keyboard.push(row);
  }
  keyboard.push([{ text: '← Providers', callbackData: 'a:providers' }]);
  const credentials = provider.credentials.map((credential) => `${credential.enabled ? '🟢' : '🔴'} ${credential.id} "${credential.label}" w${credential.weight}`).join('\n');
  return {
    text: clamp(`⚙️ Provider ${provider.id}\n\nURL: ${provider.baseUrl}\nModel: ${provider.defaultModel}\nEnabled: ${provider.enabled ? 'yes' : 'no'}\nWeight: ${provider.weight}\nTimeout: ${provider.timeoutMs} ms\nCredential attempts: ${provider.maxCredentialAttempts}\n\nCredentials:\n${credentials || 'None'}`),
    keyboard,
  };
}

export function renderConfirmation(pending: { action: string; targetType: string; targetId: string; confirmationId: string }): AdminView {
  const what = pending.action === 'credentials.delete'
    ? `permanently delete credential "${pending.targetId}"`
    : pending.action === 'users.set_role'
      ? 'change a privileged role'
      : 'block a privileged user';
  return {
    text: clamp(`⚠️ Confirmation required\n\nYou are about to ${what}.\nThis cannot be undone.`),
    keyboard: [
      [{ text: '✅ Confirm', callbackData: `a:confirm:${pending.confirmationId}` }],
      [{ text: '← Back', callbackData: 'a:menu' }],
    ],
  };
}

export function renderPolicy(policy: { role: string; dailyMessages: number; perSecond: number; perHour: number; bypassQuota: boolean; bypassRate: boolean }): AdminView {
  return {
    text: clamp(`📈 Policy — ${policy.role}\n\nDaily messages: ${policy.dailyMessages}\nPer second: ${policy.perSecond}\nPer hour: ${policy.perHour}\nBypass quota: ${policy.bypassQuota ? 'yes' : 'no'}\nBypass rate: ${policy.bypassRate ? 'yes' : 'no'}`),
    keyboard: [[backButton()]],
  };
}

export function renderTools(tools: string[]): AdminView {
  return {
    text: clamp(`🛠 Tools\n\n${tools.length > 0 ? tools.join('\n') : 'No tools registered.'}`),
    keyboard: [[backButton()]],
  };
}

export function renderUsage(summary: { generations: number; inputTokens: number; outputTokens: number; estimatedCostMicrodollars: number }): AdminView {
  const dollars = (summary.estimatedCostMicrodollars / 1_000_000).toFixed(4);
  return {
    text: clamp(`💰 Usage & Cost\n\nGenerations: ${summary.generations}\nInput tokens: ${summary.inputTokens}\nOutput tokens: ${summary.outputTokens}\nEstimated spend: $${dollars} (estimates only)`),
    keyboard: [[backButton()]],
  };
}

export function renderRouting(profiles: Array<{ profile: string; label: string; description: string }>): AdminView {
  const lines = profiles.map((entry) => `${entry.label} (${entry.profile}) — ${entry.description}`).join('\n');
  return {
    text: clamp(`🛰 Model Routing\n\n${lines}\n\nSelect profiles in conversation with /fast, /smart, /research (default when omitted).`),
    keyboard: [[backButton()]],
  };
}

export function renderAudit(records: Array<{ id: number; actorRole: string; action: string; targetType: string; targetId: string | null; success: boolean; createdAt: string }>, nextCursor: number | null): AdminView {
  const lines = records.map((record) => `#${record.id} ${record.createdAt} ${record.actorRole} ${record.action}${record.targetId !== null ? ` → ${record.targetId}` : ''}${record.success ? '' : ' [failed]'}`);
  const keyboard: InlineButton[][] = [];
  if (nextCursor !== null) keyboard.push([{ text: 'Next →', callbackData: `a:audit:${nextCursor}` }]);
  keyboard.push([backButton()]);
  return {
    text: clamp(`📋 Audit Logs\n\n${lines.length > 0 ? lines.join('\n') : 'No audit records.'}`),
    keyboard,
  };
}

export function renderError(kind: AdminError['kind']): AdminView {
  return { text: adminErrorText(kind), keyboard: [[backButton()]] };
}
