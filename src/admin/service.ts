// Phase 9 AdminService — the transport-independent administrative core.
// Every mutating operation: authorize → validate → act → audit. The Telegram
// UI layer calls these methods; it never touches D1 or business rules itself.

import type { AdminAction, AdminCapability, AdminRole } from './types';
import { capabilitiesFor } from './types';
import { AdminError } from './errors';
import { authorizeAdmin, isPrivilegedTarget } from './authorization';
import type { AdminUserRow, UserRole } from '../db/admin-users';
import {
  countOwners,
  countUsers,
  countUsersByRole,
  findUserById,
  listUsersPage,
} from '../db/admin-users';
import {
  countCredentials,
  countProviders,
  findProviderById,
  listAllProviders,
  listCredentialMetaForProvider,
} from '../db/admin-providers';
import { applyAdminMutation, validateMutation } from '../db/admin-mutations';
import { findPolicy, listPolicies, type PolicyUpdate } from '../db/admin-policies';
import { appendAuditLog, listAuditPage, type AuditPage, type AuditRecord } from '../db/admin-audit';
import { findCredentialMetaById, type AdminCredentialMeta } from '../db/admin-providers';
import { summarizeAllUsage, setProviderPrice, type UsageSummary } from '../db/usage';
import { ROUTING_PROFILE_INFO } from '../ai/routing-profiles';
import {
  consumeAdminConfirmation,
  createAdminConfirmation,
  findAdminConfirmation,
} from '../db/admin-confirmations';

/** Destructive intents that require durable confirmation before execution. */
export type DestructiveIntent =
  | { action: 'credentials.delete'; credentialId: string }
  | { action: 'users.set_role'; userId: number; expectedRole: UserRole; nextRole: UserRole }
  | { action: 'users.set_status'; userId: number; nextStatus: 'blocked' };

/** Result of a confirmed destructive execution (safe metadata only). */
export interface DestructiveOutcome {
  action: 'credentials.delete' | 'users.set_role' | 'users.set_status';
  targetType: 'credential' | 'user';
  targetId: string;
}

export interface PendingConfirmation {
  confirmationId: string;
  action: string;
  targetType: string;
  targetId: string;
}

export interface AdminAuditContext {
  requestId?: string;
}

/** Destructive confirmations live 10 minutes and are single-use. */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

/** 128-bit random confirmation id, hex-encoded (fits the callback grammar). */
function newConfirmationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface DashboardMetrics {
  totalUsers: number;
  usersByRole: Record<UserRole, number>;
  providers: { total: number; enabled: number };
  credentialCount: number;
  recentAudit: AuditRecord[];
}

export interface ProviderSummary {
  id: string;
  enabled: boolean;
  weight: number;
  defaultModel: string;
  credentialCount: number;
}

export interface ProviderDetail {
  id: string;
  baseUrl: string;
  enabled: boolean;
  weight: number;
  defaultModel: string;
  timeoutMs: number;
  maxCredentialAttempts: number;
  credentials: Array<{ id: string; label: string; enabled: boolean; weight: number }>;
}

export interface PolicySummary {
  role: UserRole;
  dailyMessages: number;
  perSecond: number;
  perHour: number;
  bypassQuota: boolean;
  bypassRate: boolean;
}

export class AdminService {
  private readonly db: D1Database;
  private readonly now: () => string;

  constructor(db: D1Database, now?: () => string) {
    this.db = db;
    this.now = now ?? (() => new Date().toISOString());
  }

  private async authorize(actorUserId: number, action: AdminAction): Promise<{ userId: number; role: AdminRole }> {
    const auth = await authorizeAdmin(this.db, actorUserId, action);
    if (!auth.ok || auth.actor === undefined) throw new AdminError(auth.kind ?? 'not_authorized', 'Admin action denied');
    return auth.actor;
  }

  private async audit(actor: { userId: number; role: AdminRole }, action: AdminAction, targetType: string, targetId: string | null, success: boolean, detail: Record<string, unknown> = {}, ctx?: AdminAuditContext): Promise<void> {
    const withRequest = ctx?.requestId !== undefined ? { ...detail, request_id: ctx.requestId } : detail;
    await appendAuditLog(this.db, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action,
      targetType,
      targetId,
      success,
      detail: JSON.stringify(withRequest),
      createdAt: this.now(),
    }).catch(() => { throw new AdminError('storage_failed', 'Audit unavailable'); });
  }

  private has(actorRole: AdminRole, capability: AdminCapability): boolean {
    return capabilitiesFor(actorRole).includes(capability);
  }

  // --- dashboard ---------------------------------------------------------------

  async getDashboard(actorUserId: number): Promise<DashboardMetrics> {
    await this.authorize(actorUserId, 'dashboard.view');
    try {
      const [totalUsers, usersByRole, providers, credentialCount, recentAudit] = await Promise.all([
        countUsers(this.db),
        countUsersByRole(this.db),
        countProviders(this.db),
        countCredentials(this.db),
        listAuditPage(this.db, null, 5),
      ]);
      return { totalUsers, usersByRole, providers, credentialCount, recentAudit: recentAudit.records };
    } catch {
      throw new AdminError('storage_failed', 'Dashboard metrics unavailable');
    }
  }

  // --- users --------------------------------------------------------------------

  async listUsers(actorUserId: number, cursor: number | null): Promise<{ users: AdminUserRow[]; nextCursor: number | null }> {
    await this.authorize(actorUserId, 'users.list');
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new AdminError('validation_failed', 'Invalid cursor');
    try {
      return await listUsersPage(this.db, cursor, 10);
    } catch {
      throw new AdminError('storage_failed', 'User list unavailable');
    }
  }

  async inspectUser(actorUserId: number, targetUserId: number): Promise<AdminUserRow> {
    await this.authorize(actorUserId, 'users.inspect');
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) throw new AdminError('validation_failed', 'Invalid user id');
    const target = await findUserById(this.db, targetUserId).catch(() => { throw new AdminError('storage_failed', 'Administrative data unavailable'); });
    if (target === null) throw new AdminError('not_found', 'User not found');
    return target;
  }

  async setUserRole(actorUserId: number, targetUserId: number, expectedRole: UserRole, nextRole: UserRole, ctx?: AdminAuditContext): Promise<void> {
    await this.precheckSetRole(actorUserId, targetUserId, expectedRole, nextRole, ctx);
    await applyAdminMutation(this.db, actorUserId, { action: 'users.set_role', target: targetUserId, expected: expectedRole, value: nextRole }, this.now(), ctx?.requestId);
  }

  /**
   * Full authorization + validation pre-check for role changes, WITHOUT any
   * mutation. Shared by setUserRole and the destructive-confirmation request
   * flow so both paths enforce identical rules (ceiling, privileged targets,
   * self-protection, last-owner guard) and audit their denials identically.
   */
  private async precheckSetRole(actorUserId: number, targetUserId: number, expectedRole: UserRole, nextRole: UserRole, ctx?: AdminAuditContext): Promise<{ actor: { userId: number; role: AdminRole }; target: AdminUserRow }> {
    const actor = await this.authorize(actorUserId, 'users.set_role');
    validateMutation({ action: 'users.set_role', target: targetUserId, expected: expectedRole, value: nextRole });
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) throw new AdminError('validation_failed', 'Invalid user id');
    if (targetUserId === actor.userId) {
      await this.audit(actor, 'users.set_role', 'user', String(targetUserId), false, { reason: 'self_change' }, ctx);
      throw new AdminError('validation_failed', 'You cannot change your own role.');
    }
    // Role-assignment ceiling: ADMINs may only grant USER/VIP; OWNER may grant any.
    const assignable = actor.role === 'OWNER' || nextRole === 'USER' || nextRole === 'VIP';
    if (!assignable) {
      await this.audit(actor, 'users.set_role', 'user', String(targetUserId), false, { reason: 'role_not_assignable', next_role: nextRole }, ctx);
      throw new AdminError('not_authorized', 'You cannot assign that role.');
    }
    const target = await findUserById(this.db, targetUserId).catch(() => { throw new AdminError('storage_failed', 'Administrative data unavailable'); });
    if (target === null) throw new AdminError('not_found', 'User not found');
    if (target.role !== expectedRole) throw new AdminError('conflict', 'User changed; reload.');
    if (isPrivilegedTarget(target.role) && !this.has(actor.role, 'manage_privileged_users')) {
      await this.audit(actor, 'users.set_role', 'user', String(targetUserId), false, { reason: 'target_privileged', target_role: target.role }, ctx);
      throw new AdminError('not_authorized', 'Owner authorization required for that target.');
    }
    if (target.role === 'OWNER' && target.status === 'active' && nextRole !== 'OWNER' && (await countOwners(this.db)) <= 1) {
      await this.audit(actor, 'user_demote_last_owner' as AdminAction, 'user', String(targetUserId), false, {}, ctx);
      throw new AdminError('conflict', 'Cannot demote the last active owner.');
    }
    return { actor, target };
  }

  async setUserStatus(actorUserId: number, targetUserId: number, nextStatus: 'active' | 'blocked', ctx?: AdminAuditContext): Promise<void> {
    await this.precheckSetStatus(actorUserId, targetUserId, nextStatus, ctx);
    await applyAdminMutation(this.db, actorUserId, { action: 'users.set_status', target: targetUserId, value: nextStatus }, this.now(), ctx?.requestId);
  }

  /** Authorization + validation pre-check for status changes, without mutation. */
  private async precheckSetStatus(actorUserId: number, targetUserId: number, nextStatus: 'active' | 'blocked', ctx?: AdminAuditContext): Promise<{ actor: { userId: number; role: AdminRole }; target: AdminUserRow }> {
    const actor = await this.authorize(actorUserId, 'users.set_status');
    if (nextStatus !== 'active' && nextStatus !== 'blocked') throw new AdminError('validation_failed', 'Invalid status');
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) throw new AdminError('validation_failed', 'Invalid user id');
    if (targetUserId === actor.userId) {
      await this.audit(actor, 'users.set_status', 'user', String(targetUserId), false, { reason: 'self_change' }, ctx);
      throw new AdminError('validation_failed', 'You cannot change your own status.');
    }
    const target = await findUserById(this.db, targetUserId).catch(() => { throw new AdminError('storage_failed', 'Administrative data unavailable'); });
    if (target === null) throw new AdminError('not_found', 'User not found');
    if (isPrivilegedTarget(target.role) && !this.has(actor.role, 'manage_privileged_users')) {
      await this.audit(actor, 'users.set_status', 'user', String(targetUserId), false, { reason: 'target_privileged', target_role: target.role }, ctx);
      throw new AdminError('not_authorized', 'Owner authorization required for that target.');
    }
    return { actor, target };
  }

  // --- providers / credentials -----------------------------------------------------

  async listProviders(actorUserId: number): Promise<ProviderSummary[]> {
    await this.authorize(actorUserId, 'providers.list');
    try {
      const providers = await listAllProviders(this.db);
      return await Promise.all(providers.map(async (provider) => ({
        id: provider.id,
        enabled: provider.enabled !== 0,
        weight: provider.weight,
        defaultModel: provider.default_model,
        credentialCount: (await listCredentialMetaForProvider(this.db, provider.id)).length,
      })));
    } catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError('storage_failed', 'Provider list unavailable');
    }
  }

  async inspectProvider(actorUserId: number, providerId: string): Promise<ProviderDetail> {
    await this.authorize(actorUserId, 'providers.inspect');
    if (!/^[a-z0-9-]{1,64}$/.test(providerId)) throw new AdminError('validation_failed', 'Invalid provider id');
    const provider = await findProviderById(this.db, providerId).catch(() => { throw new AdminError('storage_failed', 'Administrative data unavailable'); });
    if (provider === null) throw new AdminError('not_found', 'Provider not found');
    const credentials = await listCredentialMetaForProvider(this.db, providerId).catch(() => { throw new AdminError('storage_failed', 'Credential metadata unavailable'); });
    return {
      id: provider.id,
      baseUrl: provider.base_url,
      enabled: provider.enabled !== 0,
      weight: provider.weight,
      defaultModel: provider.default_model,
      timeoutMs: provider.timeout_ms,
      maxCredentialAttempts: provider.max_credential_attempts,
      credentials: credentials.map((credential) => ({ id: credential.id, label: credential.label, enabled: credential.enabled, weight: credential.weight })),
    };
  }

  /** Credential metadata lookup (never ciphertext), authorized as credentials.list. */
  async inspectCredential(actorUserId: number, credentialId: string): Promise<AdminCredentialMeta> {
    await this.authorize(actorUserId, 'credentials.list');
    if (!/^[a-z0-9-]{1,64}$/.test(credentialId)) throw new AdminError('validation_failed', 'Invalid credential id');
    const meta = await findCredentialMetaById(this.db, credentialId).catch(() => { throw new AdminError('storage_failed', 'Administrative data unavailable'); });
    if (meta === null) throw new AdminError('not_found', 'Credential not found');
    return meta;
  }

  async setProviderEnabled(actorUserId: number, providerId: string, enabled: boolean, ctx?: AdminAuditContext): Promise<void> {
    const actor = await this.authorize(actorUserId, 'providers.set_enabled');
    if (!/^[a-z0-9-]{1,64}$/.test(providerId)) throw new AdminError('validation_failed', 'Invalid provider id');
    await applyAdminMutation(this.db, actor.userId, { action: 'providers.set_enabled', target: providerId, value: enabled }, this.now(), ctx?.requestId);
  }

  async setCredentialEnabled(actorUserId: number, credentialId: string, enabled: boolean, ctx?: AdminAuditContext): Promise<void> {
    const actor = await this.authorize(actorUserId, 'credentials.set_enabled');
    if (!/^[a-z0-9-]{1,64}$/.test(credentialId)) throw new AdminError('validation_failed', 'Invalid credential id');
    await applyAdminMutation(this.db, actor.userId, { action: 'credentials.set_enabled', target: credentialId, value: enabled }, this.now(), ctx?.requestId);
  }

  async deleteCredential(actorUserId: number, credentialId: string, ctx?: AdminAuditContext): Promise<void> {
    await this.precheckDeleteCredential(actorUserId, credentialId);
    await applyAdminMutation(this.db, actorUserId, { action: 'credentials.delete', target: credentialId }, this.now(), ctx?.requestId);
  }

  /** Authorization + validation pre-check for credential deletion, without mutation. */
  private async precheckDeleteCredential(actorUserId: number, credentialId: string): Promise<void> {
    await this.authorize(actorUserId, 'credentials.delete');
    if (!/^[a-z0-9-]{1,64}$/.test(credentialId)) throw new AdminError('validation_failed', 'Invalid credential id');
    const credential = await findCredentialMetaById(this.db, credentialId).catch(() => { throw new AdminError('storage_failed', 'Administrative data unavailable'); });
    if (credential === null) throw new AdminError('not_found', 'Credential not found');
  }

  // --- destructive-action confirmation (durable, single-use, fail-closed) -----

  /**
   * Runs every authorization/validation pre-check for a destructive intent
   * WITHOUT mutating, then stores a durable D1 confirmation row binding
   * actor + action + target. Returns the confirmation id for the UI.
   */
  async requestDestructiveConfirmation(actorUserId: number, intent: DestructiveIntent, ctx?: AdminAuditContext): Promise<PendingConfirmation> {
    let targetType: 'credential' | 'user';
    let targetId: string;
    let payload: Record<string, unknown>;
    let destructive: boolean;
    switch (intent.action) {
      case 'credentials.delete':
        await this.precheckDeleteCredential(actorUserId, intent.credentialId);
        targetType = 'credential';
        targetId = intent.credentialId;
        payload = {};
        destructive = true;
        break;
      case 'users.set_role': {
        const { target } = await this.precheckSetRole(actorUserId, intent.userId, intent.expectedRole, intent.nextRole, ctx);
        targetType = 'user';
        targetId = String(intent.userId);
        payload = { expected_role: intent.expectedRole, next_role: intent.nextRole };
        // Privileged role surgery needs durable confirmation: changing a
        // privileged target, or granting a privileged role.
        destructive = isPrivilegedTarget(target.role) || intent.nextRole === 'ADMIN' || intent.nextRole === 'OWNER';
        break;
      }
      case 'users.set_status': {
        const { target } = await this.precheckSetStatus(actorUserId, intent.userId, intent.nextStatus, ctx);
        targetType = 'user';
        targetId = String(intent.userId);
        payload = { next_status: intent.nextStatus };
        // Blocking a privileged user is high-impact; unblocking is not.
        destructive = intent.nextStatus === 'blocked' && isPrivilegedTarget(target.role);
        break;
      }
      default: {
        const exhaustive: never = intent;
        throw new AdminError('validation_failed', `Unsupported intent: ${String((exhaustive as { action: string }).action)}`);
      }
    }
    if (!destructive) throw new AdminError('validation_failed', 'This action does not require confirmation.');
    const now = this.now();
    const base = Date.parse(now);
    const confirmationId = newConfirmationId();
    const expiresAt = Number.isFinite(base) ? new Date(base + CONFIRMATION_TTL_MS).toISOString() : now;
    await createAdminConfirmation(this.db, {
      id: confirmationId,
      actorUserId,
      action: intent.action,
      targetType,
      targetId,
      payload: JSON.stringify(payload),
      createdAt: now,
      expiresAt,
    }).catch(() => { throw new AdminError('storage_failed', 'Confirmation unavailable'); });
    return { confirmationId, action: intent.action, targetType, targetId };
  }

  /**
   * Reads a pending confirmation for display. Fails closed: the row must
   * belong to the caller, be unconsumed, and be unexpired.
   */
  async describeConfirmation(actorUserId: number, confirmationId: string): Promise<PendingConfirmation> {
    if (!/^[a-f0-9]{32}$/.test(confirmationId)) throw new AdminError('validation_failed', 'Invalid confirmation');
    const row = await findAdminConfirmation(this.db, confirmationId).catch(() => { throw new AdminError('storage_failed', 'Confirmation unavailable'); });
    if (row === null) throw new AdminError('not_found', 'Confirmation not found or expired.');
    if (row.actor_user_id !== actorUserId) throw new AdminError('not_authorized', 'Confirmation does not belong to you.');
    if (row.used_at !== null || row.expires_at <= this.now()) throw new AdminError('conflict', 'Confirmation expired or already used.');
    return { confirmationId: row.id, action: row.action, targetType: row.target_type, targetId: row.target_id };
  }

  /**
   * Executes a confirmed destructive action. The confirmation is consumed
   * atomically FIRST (single-use, exactly-once semantics; a later failure
   * only wastes the confirmation, never replays the mutation), then the
   * underlying AdminService method re-runs full authorization and performs
   * the audited, atomic mutation.
   */
  async executeConfirmed(actorUserId: number, confirmationId: string, ctx?: AdminAuditContext): Promise<DestructiveOutcome> {
    if (!/^[a-f0-9]{32}$/.test(confirmationId)) throw new AdminError('validation_failed', 'Invalid confirmation');
    const row = await findAdminConfirmation(this.db, confirmationId).catch(() => { throw new AdminError('storage_failed', 'Confirmation unavailable'); });
    if (row === null) throw new AdminError('not_found', 'Confirmation not found or expired.');
    // Actor binding is enforced BEFORE consumption so a stolen id is useless
    // to a different admin and never burns the original actor's confirmation.
    if (row.actor_user_id !== actorUserId) throw new AdminError('not_authorized', 'Confirmation does not belong to you.');
    if (row.used_at !== null) throw new AdminError('conflict', 'Confirmation already used.');
    if (row.expires_at <= this.now()) throw new AdminError('conflict', 'Confirmation expired.');
    const consumed = await consumeAdminConfirmation(this.db, confirmationId, this.now()).catch(() => { throw new AdminError('storage_failed', 'Confirmation unavailable'); });
    if (!consumed) throw new AdminError('conflict', 'Confirmation already used or expired.');
    const params = JSON.parse(row.payload) as Record<string, unknown>;
    switch (row.action) {
      case 'credentials.delete':
        await this.deleteCredential(actorUserId, String(params['credentialId'] ?? row.target_id), ctx);
        return { action: 'credentials.delete', targetType: 'credential', targetId: row.target_id };
      case 'users.set_role':
        await this.setUserRole(actorUserId, Number(params['userId'] ?? row.target_id), params['expected_role'] as UserRole, params['next_role'] as UserRole, ctx);
        return { action: 'users.set_role', targetType: 'user', targetId: row.target_id };
      case 'users.set_status':
        await this.setUserStatus(actorUserId, Number(params['userId'] ?? row.target_id), 'blocked', ctx);
        return { action: 'users.set_status', targetType: 'user', targetId: row.target_id };
      default:
        throw new AdminError('conflict', 'Unknown confirmation action.');
    }
  }

  /**
   * Explicit CMS base-access gate: the Telegram layer calls this before
   * rendering any admin surface. Returns the verified actor on success.
   */
  async checkAccess(actorUserId: number): Promise<{ userId: number; role: AdminRole }> {
    return this.authorize(actorUserId, 'dashboard.view');
  }


  // --- admission policies ------------------------------------------------------------

  async listPolicies(actorUserId: number): Promise<Array<{ role: UserRole; dailyMessages: number; perSecond: number; perHour: number; bypassQuota: boolean; bypassRate: boolean }>> {
    await this.authorize(actorUserId, 'policies.list');
    const rows = await listPolicies(this.db).catch(() => { throw new AdminError('storage_failed', 'Administrative data unavailable'); });
    if (rows === null) throw new AdminError('storage_failed', 'Policy list unavailable');
    return rows.map((row) => ({
      role: row.role,
      dailyMessages: row.daily_messages,
      perSecond: row.per_second,
      perHour: row.per_hour,
      bypassQuota: row.bypass_quota,
      bypassRate: row.bypass_rate,
    }));
  }

  async updatePolicy(actorUserId: number, role: UserRole, update: PolicyUpdate, ctx?: AdminAuditContext): Promise<void> {
    const actor = await this.authorize(actorUserId, 'policies.update');
    if (Object.keys(update).length === 0) throw new AdminError('validation_failed', 'No policy fields given');
    // Bypass flags and privileged-role policies are owner territory; ordinary
    // numeric edits for USER/VIP are within ADMIN power.
    const touchesPrivileged = role === 'OWNER' || role === 'ADMIN' || role === 'BLOCKED'
      || update.bypass_quota !== undefined || update.bypass_rate !== undefined;
    if (touchesPrivileged && !this.has(actor.role, 'edit_privileged_policies')) {
      await this.audit(actor, 'policies.update', 'policy', String(role), false, { reason: 'privileged_field' }, ctx);
      throw new AdminError('not_authorized', 'Owner authorization required for that policy field.');
    }
    const existing = await findPolicy(this.db, role).catch(() => { throw new AdminError('storage_failed', 'Administrative data unavailable'); });
    if (existing === null) throw new AdminError('not_found', 'Policy not found');
    await applyAdminMutation(this.db, actor.userId, { action: 'policies.update', target: role, value: update }, this.now(), ctx?.requestId);
  }

  // --- usage analytics (Phase 10, OWNER-only visibility) -------------------------

  async getUsageSummary(actorUserId: number): Promise<UsageSummary> {
    await this.authorize(actorUserId, 'usage.view');
    return summarizeAllUsage(this.db).catch(() => {
      throw new AdminError('storage_failed', 'Usage data unavailable');
    });
  }

  async setModelPrice(actorUserId: number, providerId: string, vendorModel: string, inputPerMtok: number, outputPerMtok: number, ctx?: AdminAuditContext): Promise<void> {
    const actor = await this.authorize(actorUserId, 'prices.edit');
    if (!/^[a-z0-9-]{1,64}$/.test(providerId)) throw new AdminError('validation_failed', 'Invalid provider id');
    if (typeof vendorModel !== 'string' || vendorModel.length === 0 || vendorModel.length > 128) {
      throw new AdminError('validation_failed', 'Invalid model name');
    }
    for (const value of [inputPerMtok, outputPerMtok]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 9007199254740991) throw new AdminError('validation_failed', 'Invalid price');
    }
    await setProviderPrice(this.db, providerId, vendorModel, inputPerMtok, outputPerMtok, this.now()).catch(() => {
      throw new AdminError('storage_failed', 'Price update unavailable');
    });
    await this.audit(actor, 'prices.edit', 'price', `${providerId}:${vendorModel}`, true, {}, ctx);
  }

  // --- tools / audit -------------------------------------------------------------------

  async listTools(actorUserId: number, registryNames: readonly string[]): Promise<string[]> {
    await this.authorize(actorUserId, 'tools.list');
    return registryNames
      .filter((name) => typeof name === 'string' && /^[a-z][a-z0-9_]*$/.test(name) && name.length <= 64)
      .slice(0, 20);
  }

  async getRoutingProfiles(actorUserId: number): Promise<Array<{ profile: 'FAST' | 'DEFAULT' | 'COMPLEX' | 'RESEARCH'; label: string; description: string }>> {
    await this.authorize(actorUserId, 'providers.list');
    return (['FAST', 'DEFAULT', 'COMPLEX', 'RESEARCH'] as const).map((profile) => ({
      profile,
      label: ROUTING_PROFILE_INFO[profile].label,
      description: ROUTING_PROFILE_INFO[profile].description,
    }));
  }

  async listAudit(actorUserId: number, cursor: number | null): Promise<AuditPage> {
    await this.authorize(actorUserId, 'audit.list');
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new AdminError('validation_failed', 'Invalid cursor');
    try {
      return await listAuditPage(this.db, cursor, 10);
    } catch {
      throw new AdminError('storage_failed', 'Audit list unavailable');
    }
  }
}
