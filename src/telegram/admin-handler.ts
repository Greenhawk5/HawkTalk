// Phase 9 Telegram admin handler: the transport adapter between the webhook
// and the transport-independent AdminService. This layer contains NO business
// rules — it resolves the internal actor, parses bounded callback data, calls
// AdminService (which re-authorizes every operation), and maps results/errors
// to bounded plain-text views or safe callback answers.

import type { AdminRole } from '../admin/types';
import type { AdminService } from '../admin/service';
import { AdminError, adminErrorText } from '../admin/errors';
import {
  parseAdminCallback,
  renderAddCredentialInstructions,
  renderAddProviderInstructions,
  renderConfirmation,
  renderDashboard,
  renderEditProviderField,
  renderMenu,
  renderPolicy,
  renderProviderDetail,
  renderProviderList,
  renderRouting,
  renderTools,
  renderUserDetail,
  renderUserList,
  renderUsage,
  renderAudit,
  type AdminCallback,
  type AdminView,
} from './admin-ui';
import { findInternalUserIdByTelegramId } from '../db/users';

export const ADMIN_ACCESS_DENIED_TEXT = 'You are not authorized to use admin commands.';
export const GENERIC_ADMIN_FAILURE_TEXT = 'The admin service is temporarily unavailable. Try again later.';

/** Either a full view to send as a message, or a short bounded answer text. */
export type AdminOutcome =
  | { kind: 'view'; view: AdminView }
  | { kind: 'answer'; text: string };

function errorOutcome(error: unknown): { kind: 'answer'; text: string } {
  if (error instanceof AdminError) return { kind: 'answer', text: adminErrorText(error.kind) };
  // Never leak internals; deterministic bounded text only.
  return { kind: 'answer', text: GENERIC_ADMIN_FAILURE_TEXT };
}

/** /admin command from a private chat: authorization + menu rendering. */
export async function handleAdminCommand(db: D1Database, adminService: AdminService, actorTelegramId: number): Promise<AdminOutcome> {
  const actorUserId = await findInternalUserIdByTelegramId(db, actorTelegramId).catch(() => null);
  if (actorUserId === null) return { kind: 'answer', text: ADMIN_ACCESS_DENIED_TEXT };
  try {
    await adminService.checkAccess(actorUserId);
  } catch (error) {
    return errorOutcome(error);
  }
  return { kind: 'view', view: renderMenu() };
}

async function executeAdminCallback(adminService: AdminService, actorUserId: number, actorRole: AdminRole, cb: AdminCallback): Promise<AdminOutcome> {
  switch (cb.action) {
    case 'menu':
      return { kind: 'view', view: renderMenu() };
    case 'dashboard':
      return { kind: 'view', view: renderDashboard(await adminService.getDashboard(actorUserId)) };
    case 'users': {
      const page = await adminService.listUsers(actorUserId, cb.cursor);
      return { kind: 'view', view: renderUserList(page.users, page.nextCursor) };
    }
    case 'user':
      return { kind: 'view', view: renderUserDetail(await adminService.inspectUser(actorUserId, cb.userId)) };
    case 'providers':
      return { kind: 'view', view: renderProviderList(await adminService.listProviders(actorUserId)) };
    case 'provider':
      return { kind: 'view', view: renderProviderDetail(await adminService.inspectProvider(actorUserId, cb.providerId), actorRole) };
    case 'provtog': {
      await adminService.setProviderEnabled(actorUserId, cb.providerId, cb.enabled);
      return { kind: 'view', view: renderProviderDetail(await adminService.inspectProvider(actorUserId, cb.providerId), actorRole) };
    }
    case 'credtog': {
      await adminService.setCredentialEnabled(actorUserId, cb.credentialId, cb.enabled);
      const meta = await adminService.inspectCredential(actorUserId, cb.credentialId);
      return { kind: 'view', view: renderProviderDetail(await adminService.inspectProvider(actorUserId, meta.providerId), actorRole) };
    }
    case 'credask': {
      const pending = await adminService.requestDestructiveConfirmation(actorUserId, { action: 'credentials.delete', credentialId: cb.credentialId });
      return { kind: 'view', view: renderConfirmation(pending) };
    }
    case 'confirm': {
      const outcome = await adminService.executeConfirmed(actorUserId, cb.confirmationId);
      if (outcome.targetType === 'user') {
        return { kind: 'view', view: renderUserDetail(await adminService.inspectUser(actorUserId, Number(outcome.targetId))) };
      }
      return { kind: 'answer', text: '✅ Done. The credential was deleted.' };
    }
    case 'urole': {
      const target = await adminService.inspectUser(actorUserId, cb.userId);
      if (target.role !== cb.fromRole) throw new AdminError('conflict', 'User changed; reload.');
      const privileged = target.role === 'ADMIN' || target.role === 'OWNER' || target.role === 'BLOCKED' || cb.toRole === 'ADMIN' || cb.toRole === 'OWNER';
      if (privileged) {
        const pending = await adminService.requestDestructiveConfirmation(actorUserId, {
          action: 'users.set_role',
          userId: cb.userId,
          expectedRole: cb.fromRole as typeof target.role,
          nextRole: cb.toRole as typeof target.role,
        });
        return { kind: 'view', view: renderConfirmation(pending) };
      }
      await adminService.setUserRole(actorUserId, cb.userId, cb.fromRole as typeof target.role, cb.toRole as typeof target.role);
      return { kind: 'view', view: renderUserDetail(await adminService.inspectUser(actorUserId, cb.userId)) };
    }
    case 'ustat': {
      const target = await adminService.inspectUser(actorUserId, cb.userId);
      const privilegedBlock = cb.nextStatus === 'blocked' && (target.role === 'ADMIN' || target.role === 'OWNER' || target.role === 'BLOCKED');
      if (privilegedBlock) {
        const pending = await adminService.requestDestructiveConfirmation(actorUserId, { action: 'users.set_status', userId: cb.userId, nextStatus: 'blocked' });
        return { kind: 'view', view: renderConfirmation(pending) };
      }
      await adminService.setUserStatus(actorUserId, cb.userId, cb.nextStatus);
      return { kind: 'view', view: renderUserDetail(await adminService.inspectUser(actorUserId, cb.userId)) };
    }
    case 'policy': {
      const policy = (await adminService.listPolicies(actorUserId)).find((p) => p.role === cb.role);
      if (policy === undefined) throw new AdminError('not_found', 'Policy not found');
      return { kind: 'view', view: renderPolicy(policy) };
    }
    case 'audit': {
      const page = await adminService.listAudit(actorUserId, cb.cursor);
      return { kind: 'view', view: renderAudit(page.records, page.nextCursor) };
    }
    case 'tools':
      return { kind: 'view', view: renderTools(await adminService.listTools(actorUserId, [])) };
    case 'usage':
      return { kind: 'view', view: renderUsage(await adminService.getUsageSummary(actorUserId)) };
    case 'routing':
      return { kind: 'view', view: renderRouting(await adminService.getRoutingProfiles(actorUserId)) };
    case 'credentials':
      return { kind: 'answer', text: adminErrorText('validation_failed') };
    case 'addprov':
      return { kind: 'view', view: renderAddProviderInstructions() };
    case 'editprov': {
      const detail = await adminService.inspectProvider(actorUserId, cb.providerId);
      const currentValue = cb.field === 'baseUrl' ? detail.baseUrl
        : cb.field === 'defaultModel' ? detail.defaultModel
        : cb.field === 'weight' ? String(detail.weight)
        : cb.field === 'timeoutMs' ? String(detail.timeoutMs)
        : String(detail.maxCredentialAttempts);
      return { kind: 'view', view: renderEditProviderField(cb.providerId, cb.field, currentValue) };
    }
    case 'addcred':
      return { kind: 'view', view: renderAddCredentialInstructions(cb.providerId) };
    default: {
      // Exhaustiveness guard: the grammar and this switch must stay in sync.
      const exhaustive: never = cb;
      void exhaustive;
      return { kind: 'answer', text: adminErrorText('validation_failed') };
    }
  }
}

/**
 * Executes one admin callback. Authorization is RE-CHECKED here at execution
 * time (checkAccess + every AdminService call authorizes again) — rendered
 * buttons are never trusted.
 */
export async function handleAdminCallback(db: D1Database, adminService: AdminService, actorTelegramId: number, data: string): Promise<AdminOutcome> {
  const parsed = parseAdminCallback(data);
  if (parsed === null) {
    return { kind: 'answer', text: adminErrorText('validation_failed') };
  }
  const actorUserId = await findInternalUserIdByTelegramId(db, actorTelegramId).catch(() => null);
  if (actorUserId === null) return { kind: 'answer', text: ADMIN_ACCESS_DENIED_TEXT };
  try {
    // Base CMS gate first (fails closed for USER/VIP/BLOCKED/inactive).
    const actor = await adminService.checkAccess(actorUserId);
    return await executeAdminCallback(adminService, actor.userId, actor.role, parsed);
  } catch (error) {
    return errorOutcome(error);
  }
}
