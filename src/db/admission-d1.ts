import type { Clock } from '../conversation/clock';
import { RuntimeClock } from '../conversation/clock';
import type { AdmissionDecision, AdmissionGate } from '../orchestration/admission';

export class D1AdmissionGate implements AdmissionGate {
  constructor(private readonly db: D1Database, private readonly clock: Clock = new RuntimeClock()) {}

  async admit(userId: number, updateId: number): Promise<AdmissionDecision> {
    const now = Math.floor(Date.parse(this.clock.now()) / 1000);
    if (!Number.isSafeInteger(now) || now < 0) return 'unavailable';
    const day = Math.floor(now / 86400) * 86400;
    const hour = Math.floor(now / 3600) * 3600;
    const statements = [
      this.db.prepare(`
        INSERT INTO request_admissions (update_id, user_id, admitted_at, decision, quota_units, rate_units)
        SELECT ?, ?, ?, decision,
          CASE WHEN decision = 'allowed' THEN 1 ELSE 0 END,
          CASE WHEN decision IN ('allowed', 'quota_exceeded') THEN 1 ELSE 0 END
        FROM (
          SELECT CASE
            WHEN u.role = 'BLOCKED' OR u.status != 'active' THEN 'blocked'
            WHEN p.bypass_rate = 0 AND (
              COALESCE((SELECT SUM(rate_units) FROM request_admissions WHERE user_id = u.id AND admitted_at >= ? AND admitted_at < ?), 0) >= p.per_second
              OR COALESCE((SELECT SUM(rate_units) FROM request_admissions WHERE user_id = u.id AND admitted_at >= ? AND admitted_at < ?), 0) >= p.per_hour
            ) THEN 'rate_limited'
            WHEN p.bypass_quota = 0 AND
              COALESCE((SELECT SUM(quota_units) FROM request_admissions WHERE user_id = u.id AND admitted_at >= ? AND admitted_at < ?), 0) >= p.daily_messages
              THEN 'quota_exceeded'
            ELSE 'allowed'
          END AS decision
          FROM users u JOIN admission_policies p ON p.role = u.role
          JOIN processed_updates r ON r.telegram_user_id = u.telegram_user_id
          WHERE u.id = ? AND r.update_id = ? AND r.kind = 'text' AND r.processing_state = 'claimed'
        ) WHERE true
        ON CONFLICT (update_id) DO NOTHING
      `).bind(updateId, userId, now, now, now + 1, hour, hour + 3600, day, day + 86400, userId, updateId),
      this.db.prepare(`
        SELECT CASE WHEN u.role = 'BLOCKED' OR u.status != 'active' THEN 'blocked' ELSE a.decision END AS decision
        FROM request_admissions a JOIN users u ON u.id = a.user_id
        JOIN processed_updates r ON r.telegram_user_id = u.telegram_user_id AND r.update_id = a.update_id
        WHERE a.update_id = ? AND a.user_id = ?
      `).bind(updateId, userId),
    ];
    const results = await this.db.batch<{ decision: AdmissionDecision }>(statements);
    return results[1]?.results[0]?.decision ?? 'unavailable';
  }
}
