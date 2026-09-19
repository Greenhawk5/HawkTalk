// Phase 10: cost/reliability analytics over durable D1 usage events.
// One row is recorded per successful provider generation only; failures are
// never recorded (router retries would otherwise inflate counts and spend).

export const MAX_USAGE_PAGE_SIZE = 100;
export const MAX_USAGE_EVENT_ID_CHARS = 64;

export interface UsageEventInput {
  id: string;
  userId: number;
  providerId: string;
  vendorModel: string;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

export interface UsageEventRow {
  id: string;
  user_id: number;
  provider_id: string;
  vendor_model: string;
  request_id: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_microdollars: number;
  created_at: string;
}

export interface UsageSummary {
  generations: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicrodollars: number;
}

export function validateUsageEventId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_USAGE_EVENT_ID_CHARS) {
    throw new Error('Invalid usage event id');
  }
  return value;
}

function toRow(row: Record<string, unknown>): UsageEventRow {
  return {
    id: String(row['id']),
    user_id: Number(row['user_id']),
    provider_id: String(row['provider_id']),
    vendor_model: String(row['vendor_model']),
    request_id: String(row['request_id']),
    input_tokens: Number(row['input_tokens']),
    output_tokens: Number(row['output_tokens']),
    estimated_cost_microdollars: Number(row['estimated_cost_microdollars']),
    created_at: String(row['created_at']),
  };
}

/**
 * Records one generation. Cost is a server-computed estimate from
 * provider_prices (microdollars per 1M tokens); unknown prices record cost 0.
 * Owner-scoped reads/writes: the user's own rows only. Idempotent per id: a
 * duplicate insert from a redelivered update is a no-op (INSERT OR IGNORE)
 * and reports false.
 */
export async function recordUsageEvent(db: D1Database, input: UsageEventInput): Promise<boolean> {
  const id = validateUsageEventId(input.id);
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO usage_events (id, user_id, provider_id, vendor_model, request_id, input_tokens, output_tokens, estimated_cost_microdollars, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?,
         COALESCE((
           SELECT CAST((? * p.input_microdollars_per_mtok + ? * p.output_microdollars_per_mtok) / 1000000 AS INTEGER)
           FROM provider_prices p WHERE p.provider_id = ? AND p.vendor_model = ?
         ), 0), ?`,
    )
    .bind(
      id,
      input.userId,
      input.providerId,
      input.vendorModel,
      input.requestId,
      input.inputTokens,
      input.outputTokens,
      input.inputTokens,
      input.outputTokens,
      input.providerId,
      input.vendorModel,
      input.createdAt,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

const EMPTY_SUMMARY: UsageSummary = { generations: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicrodollars: 0 };

/** Owner-scoped aggregate over all of one user's usage events. */
export async function summarizeUserUsage(db: D1Database, userId: number): Promise<UsageSummary> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS generations, COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(estimated_cost_microdollars), 0) AS cost
       FROM usage_events WHERE user_id = ?`,
    )
    .bind(userId)
    .first<Record<string, unknown>>();
  if (row === null) return { ...EMPTY_SUMMARY };
  return {
    generations: Number(row['generations']),
    inputTokens: Number(row['input_tokens']),
    outputTokens: Number(row['output_tokens']),
    estimatedCostMicrodollars: Number(row['cost']),
  };
}

/** Owner-scoped aggregate grouped by provider id (deterministic ordering). */
export async function summarizeUsageByProvider(db: D1Database, userId: number): Promise<Array<{ providerId: string; generations: number; inputTokens: number; outputTokens: number; estimatedCostMicrodollars: number }>> {
  const result = await db
    .prepare(
      `SELECT provider_id, COUNT(*) AS generations, COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(estimated_cost_microdollars), 0) AS cost
       FROM usage_events WHERE user_id = ? GROUP BY provider_id ORDER BY provider_id ASC`,
    )
    .bind(userId)
    .all<Record<string, unknown>>();
  return result.results.map((row) => ({
    providerId: String(row['provider_id']),
    generations: Number(row['generations']),
    inputTokens: Number(row['input_tokens']),
    outputTokens: Number(row['output_tokens']),
    estimatedCostMicrodollars: Number(row['cost']),
  }));
}

/** Owner-scoped page of one user's events, newest first. */
export async function listUserUsageEvents(db: D1Database, userId: number, limit: number): Promise<UsageEventRow[]> {
  const pageSize = Math.min(Math.max(1, Math.floor(limit)), MAX_USAGE_PAGE_SIZE);
  const result = await db
    .prepare('SELECT * FROM usage_events WHERE user_id = ? ORDER BY created_at DESC, id ASC LIMIT ?')
    .bind(userId, pageSize)
    .all<Record<string, unknown>>();
  return result.results.map(toRow);
}

/** OWNER-only fleet aggregate across all users. */
export async function summarizeAllUsage(db: D1Database): Promise<UsageSummary> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS generations, COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(estimated_cost_microdollars), 0) AS cost
       FROM usage_events`,
    )
    .first<Record<string, unknown>>();
  if (row === null) return { ...EMPTY_SUMMARY };
  return {
    generations: Number(row['generations']),
    inputTokens: Number(row['input_tokens']),
    outputTokens: Number(row['output_tokens']),
    estimatedCostMicrodollars: Number(row['cost']),
  };
}

/** OWNER-only upsert of a per-model price row (microdollars per 1M tokens). */
export async function setProviderPrice(
  db: D1Database,
  providerId: string,
  vendorModel: string,
  inputPerMtok: number,
  outputPerMtok: number,
  updatedAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provider_prices (provider_id, vendor_model, input_microdollars_per_mtok, output_microdollars_per_mtok, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provider_id, vendor_model) DO UPDATE SET
         input_microdollars_per_mtok = excluded.input_microdollars_per_mtok,
         output_microdollars_per_mtok = excluded.output_microdollars_per_mtok,
         updated_at = excluded.updated_at`,
    )
    .bind(providerId, vendorModel, inputPerMtok, outputPerMtok, updatedAt)
    .run();
}

