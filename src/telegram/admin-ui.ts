// Phase 9 admin UI (Telegram UX overhaul): parses admin commands/callbacks
// into structured intents and renders HTML views for the interactive panel.
// Business logic lives entirely in AdminService; this file is presentation +
// input adaptation only.
//
// Design system:
// - Views are Telegram HTML; EVERY dynamic value passes through the central
//   escaper in ./format.ts — no raw interpolation anywhere.
// - Technical values (ids, models, URLs, CLI commands) render as <code> so
//   they are copy-friendly; secrets never appear in any view.
// - One panel message per chat: navigation EDITS the message (the webhook
//   layer owns that); this file only produces view + keyboard.
// - Keyboards are two-column where suitable; ✕ Close is always a full-width
//   final row that deletes the panel (handled by the transport).

import { adminErrorText, type AdminError } from '../admin/errors';
import { bold, clampHtml, code, escapeHtml } from './format';

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
  | { action: 'close' }
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
  | { action: 'routing' }
  | { action: 'addprov' }
  | { action: 'editprov'; providerId: string; field: string }
  | { action: 'addcred'; providerId: string };

const CALLBACK_ACTIONS: ReadonlySet<string> = new Set(['menu', 'close', 'dashboard', 'users', 'user', 'policy', 'providers', 'provider', 'audit', 'tools', 'credentials', 'provtog', 'credtog', 'credask', 'confirm', 'urole', 'ustat', 'usage', 'routing', 'addprov', 'editprov', 'addcred']);
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
    case 'close':
    case 'dashboard':
    case 'providers':
    case 'tools':
    case 'usage':
    case 'routing':
      return parts.length === 2 ? { action: action as 'menu' | 'close' | 'dashboard' | 'providers' | 'tools' | 'usage' | 'routing' } : null;
    case 'users':
    case 'audit': {
      if (parts.length === 2) return { action: action as 'users' | 'audit', cursor: null };
      if (parts.length !== 3) return null;
      const cursor = numericArg(arg);
      return cursor === null ? null : { action: action as 'users' | 'audit', cursor };
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
    case 'addprov':
      return parts.length === 2 ? { action } : null;
    case 'addcred': {
      if (parts.length !== 3 || arg === undefined || !SAFE_ID.test(arg)) return null;
      return { action, providerId: arg };
    }
    case 'editprov': {
      if (parts.length !== 4 || arg === undefined || !SAFE_ID.test(arg)) return null;
      const field = parts[3] ?? '';
      if (!['baseUrl', 'defaultModel', 'weight', 'timeoutMs', 'maxCredentialAttempts'].includes(field)) return null;
      return { action, providerId: arg, field };
    }
    default: return null;
  }
}

// --- rendering (Telegram HTML; central escaping via ./format.ts) -----------

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface AdminView {
  text: string;
  keyboard: InlineButton[][];
  /** Set for HTML views; plain-text views leave it undefined. */
  parseMode?: 'HTML' | undefined;
}

function clamp(text: string): string {
  return clampHtml(text);
}

function button(text: string, callbackData: string): InlineButton {
  return { text, callbackData };
}

function backButton(target: string = 'a:menu'): InlineButton {
  return button('← Back', target);
}

/** Standard navigation: Back to the parent (when different from Home) + Home. */
function navRow(backTarget: string = 'a:menu'): InlineButton[] {
  return backTarget === 'a:menu' ? [backButton()] : [backButton(backTarget), button('🏠 Home', 'a:menu')];
}

const PROVISIONING_COMMAND = 'node --experimental-strip-types scripts/provision.mjs';

const CLOSE_ROW: InlineButton[] = [button('✕ Close', 'a:close')];

export function renderMenu(): AdminView {
  return {
    text: `${bold('🦅 HawkTalk Admin')}\n\nPick a section — everything applies live.`,
    keyboard: [
      [button('📊 Dashboard', 'a:dashboard'), button('👥 Users', 'a:users')],
      [button('🤖 Providers', 'a:providers'), button('📈 Quotas', 'a:policy:USER')],
      [button('🛠 Tools', 'a:tools'), button('📋 Audit', 'a:audit')],
      [button('💰 Usage', 'a:usage'), button('🛰 Routing', 'a:routing')],
      CLOSE_ROW,
    ],
    parseMode: 'HTML',
  };
}

function roleSummary(entries: Array<[string, number]>): string {
  return entries.map(([role, count]) => `${escapeHtml(role)} ${count}`).join(' · ');
}

export function renderDashboard(metrics: { totalUsers: number; usersByRole: Record<string, number>; providers: { total: number; enabled: number }; credentialCount: number; recentAudit: Array<{ action: string; success: boolean }> }): AdminView {
  const roles = roleSummary(Object.entries(metrics.usersByRole));
  const recent = metrics.recentAudit.length > 0
    ? metrics.recentAudit.map((entry) => `${entry.success ? '✅' : '⚠️'} ${escapeHtml(entry.action)}`).join('\n')
    : 'No admin activity yet.';
  return {
    text: clamp(`${bold('📊 Dashboard')}\n\n${bold('Users')}\n${metrics.totalUsers} total${roles.length > 0 ? ` — ${roles}` : ''}\n\n${bold('Providers')}\n${metrics.providers.enabled}/${metrics.providers.total} enabled · ${metrics.credentialCount} credential${metrics.credentialCount === 1 ? '' : 's'}\n\n${bold('Recent admin activity')}\n${recent}`),
    keyboard: [navRow(), CLOSE_ROW],
    parseMode: 'HTML',
  };
}

function statusDot(active: boolean): string {
  return active ? '🟢' : '🔴';
}

export function renderUserList(users: Array<{ id: number; telegram_user_id: number; role: string; status: string }>, nextCursor: number | null): AdminView {
  const lines = users.map((user) => `${statusDot(user.status === 'active')} <code>#${user.id}</code> tg:${code(String(user.telegram_user_id))} · ${escapeHtml(user.role)}${user.status !== 'active' ? ` · ${escapeHtml(user.status)}` : ''}`);
  const keyboard: InlineButton[][] = [];
  for (let index = 0; index < users.length && index < 10; index += 2) {
    const first = users[index];
    const second = users[index + 1];
    const row: InlineButton[] = [];
    if (first !== undefined) row.push(button(`#${first.id} ${first.role}`, `a:user:${first.id}`));
    if (second !== undefined) row.push(button(`#${second.id} ${second.role}`, `a:user:${second.id}`));
    if (row.length > 0) keyboard.push(row);
  }
  if (nextCursor !== null) keyboard.push([button('Next →', `a:users:${nextCursor}`)]);
  keyboard.push(navRow(), CLOSE_ROW);
  return {
    text: clamp(`${bold('👥 Users')}\n\n${lines.length > 0 ? lines.join('\n') : 'No users yet.'}`),
    keyboard,
    parseMode: 'HTML',
  };
}

export function renderUserDetail(user: { id: number; telegram_user_id: number; username: string | null; display_name: string | null; role: string; status: string; created_at: string }): AdminView {
  const keyboard: InlineButton[][] = [];
  const roleRow: InlineButton[] = [];
  if (user.role !== 'USER') roleRow.push(button('→ USER', `a:urole:${user.id}:${user.role}:USER`));
  if (user.role !== 'VIP') roleRow.push(button('→ VIP', `a:urole:${user.id}:${user.role}:VIP`));
  if (user.role !== 'ADMIN') roleRow.push(button('→ ADMIN', `a:urole:${user.id}:${user.role}:ADMIN`));
  if (roleRow.length > 0) keyboard.push(roleRow);
  keyboard.push([button(user.status === 'active' ? '🚫 Block' : '✅ Unblock', `a:ustat:${user.id}:${user.status === 'active' ? 'blocked' : 'active'}`)]);
  keyboard.push(navRow('a:users'), CLOSE_ROW);
  return {
    text: clamp(`${bold(`👤 User #${user.id}`)}  ${statusDot(user.status === 'active')}\n\nTelegram: ${code(String(user.telegram_user_id))}\nName: ${escapeHtml(user.display_name ?? '—')}\nUsername: ${escapeHtml(user.username ?? '—')}\nRole: ${bold(user.role)}\nStatus: ${escapeHtml(user.status)}\nCreated: ${escapeHtml(user.created_at)}`),
    keyboard,
    parseMode: 'HTML',
  };
}

export function renderProviderList(providers: Array<{ id: string; enabled: boolean; defaultModel: string; credentialCount: number }>): AdminView {
  const lines = providers.map((provider) => `${statusDot(provider.enabled)} ${code(provider.id)} — ${provider.credentialCount} credential${provider.credentialCount === 1 ? '' : 's'} · ${code(provider.defaultModel)}`);
  const keyboard: InlineButton[][] = [];
  for (let index = 0; index < providers.length && index < 10; index += 2) {
    const first = providers[index];
    const second = providers[index + 1];
    const row: InlineButton[] = [];
    if (first !== undefined) row.push(button(first.id, `a:provider:${first.id}`));
    if (second !== undefined) row.push(button(second.id, `a:provider:${second.id}`));
    if (row.length > 0) keyboard.push(row);
  }
  keyboard.push([button('➕ Add provider', 'a:addprov')]);
  keyboard.push(navRow(), CLOSE_ROW);
  return {
    text: clamp(`${bold('🤖 AI Providers')}\n\n${lines.length > 0 ? lines.join('\n') : 'No providers configured yet.'}`),
    keyboard,
    parseMode: 'HTML',
  };
}

export function renderProviderDetail(provider: { id: string; baseUrl: string; enabled: boolean; weight: number; defaultModel: string; timeoutMs: number; maxCredentialAttempts: number; credentials: Array<{ id: string; label: string; enabled: boolean; weight: number }> }, actorRole: string): AdminView {
  const keyboard: InlineButton[][] = [];
  keyboard.push([button(provider.enabled ? '⏸ Disable' : '▶ Enable', `a:provtog:${provider.id}:${provider.enabled ? 'off' : 'on'}`)]);
  keyboard.push([
    button('✏️ URL', `a:editprov:${provider.id}:baseUrl`),
    button('✏️ Model', `a:editprov:${provider.id}:defaultModel`),
  ]);
  keyboard.push([
    button('✏️ Weight', `a:editprov:${provider.id}:weight`),
    button('✏️ Timeout', `a:editprov:${provider.id}:timeoutMs`),
  ]);
  for (const credential of provider.credentials) {
    const row: InlineButton[] = [button(`${credential.enabled ? '⏸' : '▶'} ${credential.id}`, `a:credtog:${credential.id}:${credential.enabled ? 'off' : 'on'}`)];
    if (actorRole === 'OWNER') row.push(button('🗑 Delete', `a:credask:${credential.id}`));
    keyboard.push(row);
  }
  keyboard.push([button('➕ Add credential', `a:addcred:${provider.id}`)]);
  keyboard.push(navRow('a:providers'), CLOSE_ROW);
  const credentials = provider.credentials.map((credential) => `${statusDot(credential.enabled)} ${code(credential.id)} ${escapeHtml(credential.label.length > 0 ? `“${credential.label}”` : '—')} · w${credential.weight}`).join('\n');
  return {
    text: clamp(`${bold(`⚙️ Provider`)}\n\n${code(provider.id)}  ${statusDot(provider.enabled)}\n\nURL\n${code(provider.baseUrl)}\n\nDefault model\n${code(provider.defaultModel)}\n\nWeight ${code(String(provider.weight))} · Timeout ${code(`${provider.timeoutMs} ms`)} · Attempts ${code(String(provider.maxCredentialAttempts))}\n\n${bold('Credentials')}\n${credentials || 'None yet.'}`),
    keyboard,
    parseMode: 'HTML',
  };
}

export function renderConfirmation(pending: { action: string; targetType: string; targetId: string; confirmationId: string }): AdminView {
  const what = pending.action === 'credentials.delete'
    ? `permanently delete credential ${code(pending.targetId)}`
    : pending.action === 'users.set_role'
      ? 'change a privileged role'
      : 'block a privileged user';
  return {
    text: clamp(`${bold('⚠️ Confirm action')}\n\nYou are about to ${what}.\n\nThis action cannot be undone.`),
    keyboard: [
      [button('✅ Confirm', `a:confirm:${pending.confirmationId}`), button('Cancel', 'a:menu')],
      CLOSE_ROW,
    ],
    parseMode: 'HTML',
  };
}

export function renderPolicy(policy: { role: string; dailyMessages: number; perSecond: number; perHour: number; bypassQuota: boolean; bypassRate: boolean }): AdminView {
  return {
    text: clamp(`${bold(`📈 Quota — ${escapeHtml(policy.role)}`)}\n\nDaily messages: ${code(String(policy.dailyMessages))}\nPer second: ${code(String(policy.perSecond))}\nPer hour: ${code(String(policy.perHour))}\nBypass quota: ${policy.bypassQuota ? 'yes' : 'no'}\nBypass rate: ${policy.bypassRate ? 'yes' : 'no'}`),
    keyboard: [navRow(), CLOSE_ROW],
    parseMode: 'HTML',
  };
}

export function renderTools(tools: string[]): AdminView {
  const lines = tools.length > 0 ? tools.map((tool) => `• ${code(tool)}`).join('\n') : 'No tools registered.';
  return {
    text: clamp(`${bold('🛠 Tools')}\n\n${lines}`),
    keyboard: [navRow(), CLOSE_ROW],
    parseMode: 'HTML',
  };
}

export function renderRouting(profiles: Array<{ profile: string; label: string; description: string }>): AdminView {
  const lines = profiles.map((entry) => `${code(entry.profile)} ${escapeHtml(entry.label)} — ${escapeHtml(entry.description)}`).join('\n');
  return {
    text: clamp(`${bold('🛰 Model routing')}\n\n${lines}\n\nSelect a profile per message with /fast, /smart, /research (default when omitted).`),
    keyboard: [navRow(), CLOSE_ROW],
    parseMode: 'HTML',
  };
}

export function renderAudit(records: Array<{ id: number; actorRole: string; action: string; targetType: string; targetId: string | null; success: boolean; createdAt: string }>, nextCursor: number | null): AdminView {
  const lines = records.map((record) => `${record.success ? '✅' : '⚠️'} <code>#${record.id}</code> ${escapeHtml(record.createdAt)} ${escapeHtml(record.actorRole)} ${escapeHtml(record.action)}${record.targetId !== null ? ` → ${code(record.targetId)}` : ''}`);
  const keyboard: InlineButton[][] = [];
  if (nextCursor !== null) keyboard.push([button('Next →', `a:audit:${nextCursor}`)]);
  keyboard.push(navRow(), CLOSE_ROW);
  return {
    text: clamp(`${bold('📋 Audit logs')}\n\n${lines.length > 0 ? lines.join('\n') : 'No audit records yet — nothing to show.'}`),
    keyboard,
    parseMode: 'HTML',
  };
}

export function renderError(kind: AdminError['kind']): AdminView {
  return { text: adminErrorText(kind), keyboard: [navRow(), CLOSE_ROW] };
}

export function renderAddProviderInstructions(): AdminView {
  return {
    text: clamp(`${bold('➕ Add provider')}\n\nProviders are created with the secure provisioning CLI (never via chat), so the same validation always applies:\n\n${code(`${PROVISIONING_COMMAND} provider <id> <base-url> <default-model> [weight] [timeout-ms] [max-attempts] --env production`)}\n\nFields: id (lowercase [a-z0-9-]), base_url (https only), default_model. Optional: weight (1–10000, default 100), timeout_ms (1000–120000, default 30000), max_credential_attempts (1–10, default 3).\n\n⚠️ Never send API keys or configuration values through Telegram.`),
    keyboard: [navRow('a:providers'), CLOSE_ROW],
    parseMode: 'HTML',
  };
}
export function renderEditProviderField(providerId: string, field: string, currentValue: string): AdminView {
  return {
    text: clamp(`${bold('⚙️ Edit provider')}\n\nProvider\n${code(providerId)}\n\nField\n${code(field)}\n\nCurrent value\n${code(currentValue)}\n\n────────────────\n\n🔐 Configuration changes happen outside Telegram on purpose.\n\nRe-create with the provisioning CLI so the same validation applies:\n\n${code(`${PROVISIONING_COMMAND} provider ... --env production`)}\n\n⚠️ Never send configuration values or API keys through Telegram.`),
    keyboard: [navRow(`a:provider:${providerId}`), CLOSE_ROW],
    parseMode: 'HTML',
  };
}

export function renderAddCredentialInstructions(providerId: string): AdminView {
  return {
    text: clamp(`${bold('➕ Add credential')}\n\nProvider\n${code(providerId)}\n\n🔐 API keys must never be sent through Telegram — chat history persists server-side.\n\nProvision securely with the committed CLI: the key is read from a hidden prompt and sealed with AES-GCM before storage.\n\n${code(`${PROVISIONING_COMMAND} credential ${providerId} "<label>" --env production`)}\n\nThe plaintext key exists only briefly during encryption and never appears in logs, audit records, or admin listings.`),
    keyboard: [navRow(`a:provider:${providerId}`), CLOSE_ROW],
    parseMode: 'HTML',
  };
}

export function renderUsage(summary: { generations: number; inputTokens: number; outputTokens: number; estimatedCostMicrodollars: number }): AdminView {
  const dollars = (summary.estimatedCostMicrodollars / 1_000_000).toFixed(4);
  return {
    text: clamp(`${bold('💰 Usage & cost')}\n\nGenerations: ${code(String(summary.generations))}\nInput tokens: ${code(String(summary.inputTokens))}\nOutput tokens: ${code(String(summary.outputTokens))}\nEstimated spend: $${dollars} (estimates only)`),
    keyboard: [navRow(), CLOSE_ROW],
    parseMode: 'HTML',
  };
}
