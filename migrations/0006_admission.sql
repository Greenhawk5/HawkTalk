ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'USER'
  CHECK (role IN ('OWNER', 'ADMIN', 'VIP', 'USER', 'BLOCKED'));

CREATE TABLE admission_policies (
  role TEXT PRIMARY KEY CHECK (role IN ('OWNER', 'ADMIN', 'VIP', 'USER', 'BLOCKED')),
  daily_messages INTEGER NOT NULL CHECK (daily_messages >= 0),
  per_second INTEGER NOT NULL CHECK (per_second >= 0),
  per_hour INTEGER NOT NULL CHECK (per_hour >= 0),
  bypass_quota INTEGER NOT NULL DEFAULT 0 CHECK (bypass_quota IN (0, 1)),
  bypass_rate INTEGER NOT NULL DEFAULT 0 CHECK (bypass_rate IN (0, 1))
);

INSERT INTO admission_policies (role, daily_messages, per_second, per_hour, bypass_quota, bypass_rate) VALUES
  ('USER', 100, 2, 60, 0, 0),
  ('VIP', 500, 4, 240, 0, 0),
  ('ADMIN', 100, 2, 60, 1, 0),
  ('OWNER', 100, 2, 60, 1, 0),
  ('BLOCKED', 0, 0, 0, 0, 0);

CREATE TABLE request_admissions (
  update_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'blocked', 'rate_limited', 'quota_exceeded')),
  quota_units INTEGER NOT NULL CHECK (quota_units IN (0, 1)),
  rate_units INTEGER NOT NULL CHECK (rate_units IN (0, 1)),
  CHECK (quota_units = CASE WHEN decision = 'allowed' THEN 1 ELSE 0 END),
  CHECK (rate_units = CASE WHEN decision IN ('allowed', 'quota_exceeded') THEN 1 ELSE 0 END)
);

CREATE INDEX request_admissions_user_time ON request_admissions (user_id, admitted_at);
