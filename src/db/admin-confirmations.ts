// Phase 9 durable confirmation state for destructive admin actions.
// Rows are actor+action+target bound, single-use, and short-lived. The claim
// to consume is a guarded UPDATE (used_at IS NULL AND unexpired) so concurrent
// or duplicate deliveries can never execute the mutation twice. D1-backed:
// survives Worker isolate loss. No secret material is ever stored here.

export interface AdminConfirmationRow {
  id: string;
  actor_user_id: number;
  action: string;
  target_type: string;
  target_id: string;
  payload: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export interface CreateConfirmationInput {
  id: string;
  actorUserId: number;
  action: string;
  targetType: string;
  targetId: string;
  payload: string;
  createdAt: string;
  expiresAt: string;
}

export async function createAdminConfirmation(db: D1Database, input: CreateConfirmationInput): Promise<void> {
  // Housekeeping: drop this actor's expired rows so the table stays bounded.
  await db
    .prepare('DELETE FROM admin_confirmations WHERE actor_user_id = ? AND expires_at <= ?')
    .bind(input.actorUserId, input.createdAt)
    .run();
  await db
    .prepare(
      'INSERT INTO admin_confirmations (id, actor_user_id, action, target_type, target_id, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(input.id, input.actorUserId, input.action, input.targetType, input.targetId, input.payload, input.createdAt, input.expiresAt)
    .run();
}

export async function findAdminConfirmation(db: D1Database, id: string): Promise<AdminConfirmationRow | null> {
  const row = await db.prepare('SELECT * FROM admin_confirmations WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (row === null) return null;
  return {
    id: String(row['id']),
    actor_user_id: Number(row['actor_user_id']),
    action: String(row['action']),
    target_type: String(row['target_type']),
    target_id: String(row['target_id']),
    payload: String(row['payload']),
    created_at: String(row['created_at']),
    expires_at: String(row['expires_at']),
    used_at: typeof row['used_at'] === 'string' ? String(row['used_at']) : null,
  };
}

/**
 * Atomically consumes a confirmation: exactly one caller wins. Fails closed
 * when the row was already used, has expired, or no longer exists.
 */
export async function consumeAdminConfirmation(db: D1Database, id: string, now: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE admin_confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?')
    .bind(now, id, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
