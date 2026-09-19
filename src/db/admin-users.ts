// Phase 9 admin user-management data access. Every statement is prepared and
// parameterized. Mutations are narrowly scoped guards — the caller (admin
// service) enforces role hierarchy; this layer only refuses impossible rows.

export type UserRole = 'OWNER' | 'ADMIN' | 'VIP' | 'USER' | 'BLOCKED';

export const USER_ROLES: readonly UserRole[] = ['OWNER', 'ADMIN', 'VIP', 'USER', 'BLOCKED'];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

export interface AdminUserRow {
  id: number;
  telegram_user_id: number;
  username: string | null;
  display_name: string | null;
  role: UserRole;
  status: string;
  created_at: string;
  last_seen: string;
}

function toRole(value: unknown): UserRole {
  return isUserRole(value) ? value : 'USER';
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countUsersByRole(db: D1Database): Promise<Record<UserRole, number>> {
  const rows = await db.prepare('SELECT role, COUNT(*) AS count FROM users GROUP BY role').all<{ role: string; count: number }>();
  const out: Record<UserRole, number> = { OWNER: 0, ADMIN: 0, VIP: 0, USER: 0, BLOCKED: 0 };
  for (const row of rows.results) out[toRole(row.role)] = row.count;
  return out;
}

export interface ListUsersPage {
  users: AdminUserRow[];
  nextCursor: number | null;
}

/** Keyset pagination by id. `afterId` null = first page. Bounded pageSize. */
export async function listUsersPage(db: D1Database, afterId: number | null, pageSize: number): Promise<ListUsersPage> {
  const size = Math.min(Math.max(1, Math.floor(pageSize)), 20);
  const result = afterId === null
    ? await db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT ?').bind(size + 1).all<Record<string, unknown>>()
    : await db.prepare('SELECT * FROM users WHERE id > ? ORDER BY id ASC LIMIT ?').bind(afterId, size + 1).all<Record<string, unknown>>();
  const rows = result.results;
  const hasMore = rows.length > size;
  const users = rows.slice(0, size).map((row) => toAdminUserRow(row));
  const last = users.at(-1);
  return { users, nextCursor: hasMore && last !== undefined ? last.id : null };
}

export async function findUserById(db: D1Database, userId: number): Promise<AdminUserRow | null> {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<Record<string, unknown>>();
  return row === null ? null : toAdminUserRow(row);
}

export function toAdminUserRow(row: Record<string, unknown>): AdminUserRow {
  return {
    id: Number(row['id']),
    telegram_user_id: Number(row['telegram_user_id']),
    username: typeof row['username'] === 'string' ? row['username'] : null,
    display_name: typeof row['display_name'] === 'string' ? row['display_name'] : null,
    role: toRole(row['role']),
    status: typeof row['status'] === 'string' ? row['status'] : 'active',
    created_at: String(row['created_at']),
    last_seen: String(row['last_seen']),
  };
}

/**
 * Role change with a strict single-row guard: only the named user, only when
 * their role still matches the caller's observed value (optimistic concurrency
 * against concurrent admin edits). Returns false when nothing was changed.
 */
export async function updateUserRole(db: D1Database, userId: number, expectedRole: UserRole, nextRole: UserRole): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET role = ? WHERE id = ? AND role = ? AND role != ?`,
    )
    .bind(nextRole, userId, expectedRole, nextRole)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Active/blocked status flip. Keeps Phase 8 semantics: 'blocked' users fail
 * closed in admission regardless of role. Only these two statuses exist today.
 */
export async function updateUserStatus(db: D1Database, userId: number, expectedStatus: string, nextStatus: 'active' | 'blocked'): Promise<boolean> {
  if (nextStatus !== 'active' && nextStatus !== 'blocked') return false;
  const result = await db
    .prepare(`UPDATE users SET status = ? WHERE id = ? AND status = ? AND status != ?`)
    .bind(nextStatus, userId, expectedStatus, nextStatus)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Count of active OWNER accounts (for last-owner guard). */
export async function countOwners(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'OWNER' AND status = 'active'").first<{ count: number }>();
  return row?.count ?? 0;
}
