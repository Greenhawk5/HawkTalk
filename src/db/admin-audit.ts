// Phase 9 append-only audit log. Writers only INSERT; the CMS exposes no edit
// or delete path. detail is bounded safe metadata JSON — never secrets.

import type { UserRole } from './admin-users';

export const MAX_AUDIT_ACTION_CHARS = 64;
export const MAX_AUDIT_TARGET_TYPE_CHARS = 32;
export const MAX_AUDIT_TARGET_ID_CHARS = 128;
export const MAX_AUDIT_DETAIL_CHARS = 2000;

export interface AuditEntry {
  actorUserId: number;
  actorRole: UserRole;
  action: string;
  targetType: string;
  targetId: string | null;
  success: boolean;
  detail: string;
  createdAt: string;
}

function bounded(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Appends one audit record. Best-effort: never throws into the caller's flow. */
export async function appendAuditLog(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare('INSERT INTO admin_audit_logs (actor_user_id, actor_role, action, target_type, target_id, success, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(
      entry.actorUserId,
      entry.actorRole,
      bounded(entry.action, MAX_AUDIT_ACTION_CHARS),
      bounded(entry.targetType, MAX_AUDIT_TARGET_TYPE_CHARS),
      entry.targetId === null ? null : bounded(entry.targetId, MAX_AUDIT_TARGET_ID_CHARS),
      entry.success ? 1 : 0,
      bounded(entry.detail, MAX_AUDIT_DETAIL_CHARS) || '{}',
      entry.createdAt,
    )
    .run();
}

export interface AuditRecord {
  id: number;
  actorUserId: number;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  success: boolean;
  detail: string;
  createdAt: string;
}

export interface AuditPage {
  records: AuditRecord[];
  nextCursor: number | null;
}

export async function listAuditPage(db: D1Database, beforeId: number | null, pageSize: number): Promise<AuditPage> {
  const size = Math.min(Math.max(1, Math.floor(pageSize)), 20);
  const result = beforeId === null
    ? await db.prepare('SELECT * FROM admin_audit_logs ORDER BY id DESC LIMIT ?').bind(size + 1).all<Record<string, unknown>>()
    : await db.prepare('SELECT * FROM admin_audit_logs WHERE id < ? ORDER BY id DESC LIMIT ?').bind(beforeId, size + 1).all<Record<string, unknown>>();
  const hasMore = result.results.length > size;
  const records: AuditRecord[] = result.results.slice(0, size).map((row) => ({
    id: Number(row['id']),
    actorUserId: Number(row['actor_user_id']),
    actorRole: String(row['actor_role']),
    action: String(row['action']),
    targetType: String(row['target_type']),
    targetId: row['target_id'] === null || row['target_id'] === undefined ? null : String(row['target_id']),
    success: Number(row['success']) !== 0,
    detail: String(row['detail']),
    createdAt: String(row['created_at']),
  }));
  const last = records.at(-1);
  return { records, nextCursor: hasMore && last !== undefined ? last.id : null };
}

export async function countAuditRecords(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM admin_audit_logs').first<{ count: number }>();
  return row?.count ?? 0;
}
