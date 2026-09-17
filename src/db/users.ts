// Phase 6: internal user resolution. Telegram identity is an identifier, not
// authorization; ownership inside conversations uses the internal users.id.

export async function findInternalUserIdByTelegramId(db: D1Database, telegramUserId: number): Promise<number | null> {
  const row = await db
    .prepare('SELECT id FROM users WHERE telegram_user_id = ?')
    .bind(telegramUserId)
    .first<{ id: number }>();
  return row?.id ?? null;
}
