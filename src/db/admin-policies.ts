// Phase 9 admin admission-policy data access. Values are bounded here (last
// line of defense); semantic validation lives in the admin service.

import type { UserRole } from './admin-users';
import { isUserRole } from './admin-users';

export const MAX_POLICY_VALUE = 1_000_000;

export interface AdmissionPolicyRow {
  role: UserRole;
  daily_messages: number;
  per_second: number;
  per_hour: number;
  bypass_quota: boolean;
  bypass_rate: boolean;
}

function toPolicy(row: Record<string, unknown>): AdmissionPolicyRow {
  const role = row['role'];
  return {
    role: isUserRole(role) ? role : 'USER',
    daily_messages: Number(row['daily_messages']),
    per_second: Number(row['per_second']),
    per_hour: Number(row['per_hour']),
    bypass_quota: Number(row['bypass_quota']) !== 0,
    bypass_rate: Number(row['bypass_rate']) !== 0,
  };
}

export async function listPolicies(db: D1Database): Promise<AdmissionPolicyRow[]> {
  const result = await db
    .prepare(`SELECT * FROM admission_policies ORDER BY CASE role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 WHEN 'VIP' THEN 2 WHEN 'USER' THEN 3 ELSE 4 END`)
    .all<Record<string, unknown>>();
  return result.results.map(toPolicy);
}

export async function findPolicy(db: D1Database, role: UserRole): Promise<AdmissionPolicyRow | null> {
  const row = await db.prepare('SELECT * FROM admission_policies WHERE role = ?').bind(role).first<Record<string, unknown>>();
  return row === null ? null : toPolicy(row);
}

export interface PolicyUpdate {
  daily_messages?: number;
  per_second?: number;
  per_hour?: number;
  bypass_quota?: boolean;
  bypass_rate?: boolean;
}

/**
 * Applies a bounded partial update. Every value is validated with strict
 * integer bounds before reaching SQL; unknown fields are rejected by the
 * service layer. Returns false when the role row does not exist.
 */
export async function updatePolicy(db: D1Database, role: UserRole, update: PolicyUpdate): Promise<boolean> {
  const sets: string[] = [];
  const binds: Array<string | number> = [];
  const int = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_POLICY_VALUE) return -1;
    return value;
  };
  if (update.daily_messages !== undefined) {
    const value = int(update.daily_messages);
    if (value < 0) return false;
    sets.push('daily_messages = ?');
    binds.push(value);
  }
  if (update.per_second !== undefined) {
    const value = int(update.per_second);
    if (value < 0) return false;
    sets.push('per_second = ?');
    binds.push(value);
  }
  if (update.per_hour !== undefined) {
    const value = int(update.per_hour);
    if (value < 0) return false;
    sets.push('per_hour = ?');
    binds.push(value);
  }
  if (update.bypass_quota !== undefined) {
    sets.push('bypass_quota = ?');
    binds.push(update.bypass_quota ? 1 : 0);
  }
  if (update.bypass_rate !== undefined) {
    sets.push('bypass_rate = ?');
    binds.push(update.bypass_rate ? 1 : 0);
  }
  if (sets.length === 0) return false;
  const result = await db
    .prepare(`UPDATE admission_policies SET ${sets.join(', ')} WHERE role = ?`)
    .bind(...binds, role)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
