// Phase 9 admin authorization. Explicit CMS access gate: OWNER/ADMIN only,
// failing closed on unknown, inactive, or blocked users. Privileged targets
// (ADMIN/OWNER/BLOCKED) require OWNER capabilities upstream in AdminService.

import type { AdminAction, AdminRole } from './types';
import { findUserById, type UserRole } from '../db/admin-users';

export interface AdminAuthorizationResult {
  ok: boolean;
  kind?: 'not_authorized' | 'storage_failed';
  actor?: { userId: number; role: AdminRole };
}

/** Targets that only OWNER may mutate through the CMS. */
export function isPrivilegedTarget(role: UserRole): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'BLOCKED';
}

export async function authorizeAdmin(
  db: D1Database,
  actorUserId: number,
  action: AdminAction,
): Promise<AdminAuthorizationResult> {
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    return { ok: false, kind: 'not_authorized' };
  }
  let role: UserRole;
  try {
    const user = await findUserById(db, actorUserId);
    // Non-active status (e.g. blocked OWNER) fails closed: Phase 8 admission
    // semantics apply to administrators too.
    if (user === null || user.status !== 'active') return { ok: false, kind: 'not_authorized' };
    role = user.role;
    // Only OWNER and ADMIN may use admin commands.
    if (role !== 'OWNER' && role !== 'ADMIN') return { ok: false, kind: 'not_authorized' };
  } catch {
    return { ok: false, kind: 'storage_failed' };
  }
  // OWNER may perform all admin actions.
  if (role === 'OWNER') return { ok: true, actor: { userId: actorUserId, role } };
  // ADMIN may perform routine operations on USER/VIP targets and ordinary
  // provider/credential toggles. All other actions are denied.
  const adminRoutineActions: ReadonlySet<string> = new Set([
    'dashboard.view',
    'users.list',
    'users.inspect',
    'users.set_role',
    'users.set_status',
    'providers.list',
    'providers.inspect',
    'providers.set_enabled',
    'credentials.list',
    'credentials.set_enabled',
    'policies.list',
    'policies.update',
    'tools.list',
    'audit.list',
  ]);
  if (adminRoutineActions.has(action)) return { ok: true, actor: { userId: actorUserId, role } };
  return { ok: false, kind: 'not_authorized' };
}
