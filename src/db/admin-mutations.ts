import type { UserRole } from './admin-users';
import { isUserRole } from './admin-users';
import type { PolicyUpdate } from './admin-policies';
import type { ProviderInsertParams, ProviderUpdateFields, CredentialInsertParams } from '../admin/provisioning';
import { AdminError } from '../admin/errors';

export type AdminMutation =
  | { action: 'users.set_role'; target: number; expected: UserRole; value: UserRole }
  | { action: 'users.set_status'; target: number; value: 'active' | 'blocked' }
  | { action: 'providers.set_enabled' | 'credentials.set_enabled'; target: string; value: boolean }
  | { action: 'credentials.delete'; target: string }
  | { action: 'policies.update'; target: UserRole; value: PolicyUpdate }
  | { action: 'providers.create'; target: string; value: ProviderInsertParams }
  | { action: 'providers.update'; target: string; value: ProviderUpdateFields }
  | { action: 'credentials.create'; target: string; value: CredentialInsertParams };

export function validateMutation(m: AdminMutation): void {
  if (m.action === 'users.set_role' || m.action === 'users.set_status') {
    if (!Number.isSafeInteger(m.target) || m.target <= 0) throw new AdminError('validation_failed', 'Invalid target');
    if (m.action === 'users.set_role' && (!isUserRole(m.expected) || !isUserRole(m.value))) throw new AdminError('validation_failed', 'Invalid role');
    if (m.action === 'users.set_status' && m.value !== 'active' && m.value !== 'blocked') throw new AdminError('validation_failed', 'Invalid status');
  } else if (m.action === 'policies.update') {
    if (!isUserRole(m.target) || m.value === null || typeof m.value !== 'object' || Array.isArray(m.value)) throw new AdminError('validation_failed', 'Invalid policy');
    const entries = Object.entries(m.value);
    if (entries.length === 0) throw new AdminError('validation_failed', 'Empty policy');
    for (const [key, value] of entries) {
      if (key === 'bypass_rate' || key === 'bypass_quota') {
        if (typeof value !== 'boolean') throw new AdminError('validation_failed', 'Invalid flag');
      } else if (['daily_messages', 'per_second', 'per_hour'].includes(key)) {
        if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) throw new AdminError('validation_failed', 'Invalid limit');
      } else throw new AdminError('validation_failed', 'Unknown field');
    }
  } else if (m.action === 'providers.create') {
    if (typeof m.target !== 'string' || !/^[a-z0-9-]{1,64}$/.test(m.target)) throw new AdminError('validation_failed', 'Invalid identifier');
    const v = m.value;
    if (!v || typeof v !== 'object') throw new AdminError('validation_failed', 'providers.create requires an object value');
    if (typeof v.id !== 'string' || typeof v.baseUrl !== 'string' || typeof v.defaultModel !== 'string' ||
        typeof v.weight !== 'number' || typeof v.timeoutMs !== 'number' || typeof v.maxCredentialAttempts !== 'number') {
      throw new AdminError('validation_failed', 'providers.create value missing required fields');
    }
  } else if (m.action === 'providers.update') {
    if (typeof m.target !== 'string' || !/^[a-z0-9-]{1,64}$/.test(m.target)) throw new AdminError('validation_failed', 'Invalid identifier');
    const v = m.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AdminError('validation_failed', 'providers.update requires an object value');
  } else if (m.action === 'credentials.create') {
    if (typeof m.target !== 'string' || !/^[a-z0-9-]{1,64}$/.test(m.target)) throw new AdminError('validation_failed', 'Invalid identifier');
    const v = m.value;
    if (!v || typeof v !== 'object') throw new AdminError('validation_failed', 'credentials.create requires an object value');
    if (typeof v.id !== 'string' || typeof v.providerId !== 'string' || typeof v.label !== 'string' ||
        typeof v.weight !== 'number' || typeof v.sealedCiphertext !== 'string') {
      throw new AdminError('validation_failed', 'credentials.create value missing required fields');
    }
  } else {
    if (typeof m.target !== 'string' || !/^[a-z0-9-]{1,64}$/.test(m.target)) throw new AdminError('validation_failed', 'Invalid identifier');
    if (m.action !== 'credentials.delete' && typeof m.value !== 'boolean') throw new AdminError('validation_failed', 'Invalid flag');
  }
}

export async function applyAdminMutation(db: D1Database, actorId: number, m: AdminMutation, timestamp: string, requestId?: string, detail: Record<string, unknown> = {}): Promise<void> {
  validateMutation(m);
  const actorGuard = `EXISTS (SELECT 1 FROM users actor WHERE actor.id = ? AND actor.status = 'active' AND actor.role IN ('ADMIN', 'OWNER')`;
  let sql: string;
  let values: Array<string | number>;
  let targetType: string;
  switch (m.action) {
    case 'users.set_role':
      targetType = 'user';
      sql = `UPDATE users SET role = ?, updated_at = ? WHERE id = ? AND id != ? AND role = ? AND role != ?
        AND ${actorGuard} AND (actor.role = 'OWNER' OR (users.role IN ('USER','VIP') AND ? IN ('USER','VIP'))))
        AND (role != 'OWNER' OR status != 'active' OR ? = 'OWNER' OR (SELECT COUNT(*) FROM users WHERE role = 'OWNER' AND status = 'active') > 1)`;
      values = [m.value, timestamp, m.target, actorId, m.expected, m.value, actorId, m.value, m.value];
      break;
    case 'users.set_status':
      targetType = 'user';
      sql = `UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND id != ? AND status != ?
        AND ${actorGuard} AND (actor.role = 'OWNER' OR users.role IN ('USER','VIP')))
        AND (role != 'OWNER' OR status != 'active' OR ? = 'active' OR (SELECT COUNT(*) FROM users WHERE role = 'OWNER' AND status = 'active') > 1)`;
      values = [m.value, timestamp, m.target, actorId, m.value, actorId, m.value];
      break;
    case 'providers.set_enabled':
    case 'credentials.set_enabled': {
      const table = m.action === 'providers.set_enabled' ? 'providers' : 'provider_credentials';
      targetType = m.action === 'providers.set_enabled' ? 'provider' : 'credential';
      sql = `UPDATE ${table} SET enabled = ?, updated_at = ? WHERE id = ? AND enabled != ? AND ${actorGuard})`;
      values = [Number(m.value), timestamp, m.target, Number(m.value), actorId];
      break;
    }
    case 'credentials.delete':
      targetType = 'credential';
      sql = `DELETE FROM provider_credentials WHERE id = ? AND ${actorGuard} AND actor.role = 'OWNER')`;
      values = [m.target, actorId];
      break;
    case 'providers.create': {
      targetType = 'provider';
      const p = m.value;
      sql = `INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) SELECT ?, ?, 1, ?, ?, ?, ?, ?, ? WHERE ${actorGuard})`;
      values = [p.id, p.baseUrl, p.weight, p.defaultModel, p.timeoutMs, p.maxCredentialAttempts, timestamp, timestamp, actorId];
      break;
    }
    case 'providers.update': {
      targetType = 'provider';
      const fields = m.value;
      const setClauses: string[] = [];
      const setValues: Array<string | number> = [];
      if (fields.baseUrl !== undefined) { setClauses.push('base_url = ?'); setValues.push(fields.baseUrl); }
      if (fields.defaultModel !== undefined) { setClauses.push('default_model = ?'); setValues.push(fields.defaultModel); }
      if (fields.weight !== undefined) { setClauses.push('weight = ?'); setValues.push(fields.weight); }
      if (fields.timeoutMs !== undefined) { setClauses.push('timeout_ms = ?'); setValues.push(fields.timeoutMs); }
      if (fields.maxCredentialAttempts !== undefined) { setClauses.push('max_credential_attempts = ?'); setValues.push(fields.maxCredentialAttempts); }
      if (setClauses.length === 0) throw new AdminError('validation_failed', 'No fields to update');
      setClauses.push('updated_at = ?');
      setValues.push(timestamp);
      setValues.push(m.target);
      sql = `UPDATE providers SET ${setClauses.join(', ')} WHERE id = ? AND ${actorGuard})`;
      values = [...setValues, actorId];
      break;
    }
    case 'credentials.create': {
      targetType = 'credential';
      const c = m.value;
      sql = `INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) SELECT ?, ?, ?, 1, ?, ?, ?, ? WHERE ${actorGuard})`;
      values = [c.id, c.providerId, c.label, c.weight, c.sealedCiphertext, timestamp, timestamp, actorId];
      break;
    }
    case 'policies.update': {
      targetType = 'policy';
      const entries = Object.entries(m.value);
      const privileged = !['USER', 'VIP'].includes(m.target) || entries.some(([key]) => key.startsWith('bypass_'));
      sql = `UPDATE admission_policies SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE role = ? AND ${actorGuard} AND (? = 0 OR actor.role = 'OWNER'))`;
      values = [...entries.map(([, value]) => Number(value)), m.target, actorId, Number(privileged)];
      break;
    }
    default: throw new AdminError('validation_failed', 'Unknown action');
  }
  // D1 batches roll back the mutation if its audit INSERT fails.
  let result: D1Result[];
  try {
    result = await db.batch([
      db.prepare(sql).bind(...values),
      db.prepare(`INSERT INTO admin_audit_logs (actor_user_id, actor_role, action, target_type, target_id, success, detail, created_at)
        SELECT id, role, ?, ?, ?, CASE WHEN changes() > 0 THEN 1 ELSE 0 END, ?, ?
        FROM users WHERE id = ? AND role IN ('ADMIN','OWNER')`)
        .bind(m.action, targetType, String(m.target), JSON.stringify({ ...detail, request_id: requestId?.slice(0, 128) ?? null }), timestamp, actorId),
    ]);
  } catch {
    throw new AdminError('storage_failed', 'Administrative change unavailable');
  }
  if ((result[0]?.meta.changes ?? 0) === 0) throw new AdminError('conflict', 'Change not applied');
}
