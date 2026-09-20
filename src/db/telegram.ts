// Phase 2 data-access helpers. All queries are prepared statements with bound
// parameters (no string interpolation) and are scoped by Telegram user ID.
// (D1Database is a global type provided by the generated worker configuration.)

// --- users ---------------------------------------------------------------

export interface TelegramUserInput {
  telegramUserId: number;
  username: string | null;
  displayName: string | null;
}

export async function upsertTelegramUser(db: D1Database, input: TelegramUserInput, now: string, ownerTelegramId?: string): Promise<void> {
  const isOwner = typeof ownerTelegramId === 'string' && ownerTelegramId.length > 0 && String(input.telegramUserId) === ownerTelegramId;
  if (isOwner) {
    await db
      .prepare(
        `INSERT INTO users (telegram_user_id, username, display_name, role, status, created_at, updated_at, last_seen)
         VALUES (?, ?, ?, 'OWNER', 'active', ?, ?, ?)
         ON CONFLICT (telegram_user_id) DO UPDATE SET
           username = excluded.username,
           display_name = excluded.display_name,
           role = CASE WHEN excluded.role = 'OWNER' THEN 'OWNER' ELSE users.role END,
           updated_at = excluded.updated_at,
           last_seen = excluded.last_seen`,
      )
      .bind(input.telegramUserId, input.username, input.displayName, now, now, now)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO users (telegram_user_id, username, display_name, role, status, created_at, updated_at, last_seen)
         VALUES (?, ?, ?, 'USER', 'active', ?, ?, ?)
         ON CONFLICT (telegram_user_id) DO UPDATE SET
           username = excluded.username,
           display_name = excluded.display_name,
           updated_at = excluded.updated_at,
           last_seen = excluded.last_seen`,
      )
      .bind(input.telegramUserId, input.username, input.displayName, now, now, now)
      .run();
  }
}

export async function getTelegramUserRole(db: D1Database, telegramUserId: number): Promise<string | null> {
  const row = await db
    .prepare('SELECT role FROM users WHERE telegram_user_id = ?')
    .bind(telegramUserId)
    .first<{ role: string }>();
  return row?.role ?? null;
}

export async function countUsersByTelegramId(db: D1Database, telegramUserId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM users WHERE telegram_user_id = ?')
    .bind(telegramUserId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// --- processed_updates (idempotency) --------------------------------------
// The claim is a single atomic INSERT guarded by the PRIMARY KEY on update_id.
// There is deliberately no SELECT-then-INSERT sequence: concurrent deliveries
// of the same update cannot both win the insert. ON CONFLICT DO NOTHING turns
// the loser into meta.changes === 0 instead of an error.

export async function claimUpdate(
  db: D1Database,
  updateId: number,
  telegramUserId: number | null,
  kind: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare('INSERT INTO processed_updates (update_id, telegram_user_id, kind, received_at) VALUES (?, ?, ?, ?) ON CONFLICT (update_id) DO NOTHING')
    .bind(updateId, telegramUserId, kind, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Releases a claim so a later Telegram redelivery can reprocess the update.
// Used ONLY when processing failed after claiming (e.g. reply send failed and
// we returned 500). Success and duplicate paths never release.
export async function releaseUpdateClaim(db: D1Database, updateId: number): Promise<void> {
  await db.prepare('DELETE FROM processed_updates WHERE update_id = ? AND processing_state = \'claimed\'').bind(updateId).run();
}

export async function countProcessedUpdates(db: D1Database, updateId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM processed_updates WHERE update_id = ?')
    .bind(updateId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
