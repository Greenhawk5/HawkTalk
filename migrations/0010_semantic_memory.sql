-- Phase 10: semantic memory — durable metadata + Vectorize vector references.
--
-- Split table design (matches the architecture's separation of the
-- owner-visible fact from its embedding reference):
--   memories          — owner-scoped content + lifecycle status
--   memory_embeddings — vector id / provider / model / dimensions / sync state
--
-- D1 and Vectorize are SEPARATE systems: no cross-system atomicity is claimed.
-- Sequencing used by the service (see src/memory/semantic-memory.ts):
--   insert memory(status='pending') → embed → Vectorize upsert
--   → mark memory(status='active') + embedding(vector_state='synced')
-- Recall only ever returns rows that are BOTH active and synced, so a row can
-- never look searchable while having no vector. Failures leave explicit
-- 'failed' states that are never returned. Retries are idempotent by id.

CREATE TABLE memories (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'
    AND substr(id, 15, 1) = '4' AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (length(content) BETWEEN 2 AND 2000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 24 AND julianday(updated_at) IS NOT NULL AND updated_at >= created_at
  )
);

-- Owner-scoped listing/recall lookups (newest first, deterministic id tiebreak).
CREATE INDEX idx_memories_user_created ON memories (user_id, created_at DESC, id ASC);
CREATE INDEX idx_memories_user_status ON memories (user_id, status);

CREATE TABLE memory_embeddings (
  memory_id TEXT NOT NULL PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  vector_id TEXT NOT NULL UNIQUE CHECK (length(vector_id) BETWEEN 1 AND 128),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 64),
  vendor_model TEXT NOT NULL CHECK (length(vendor_model) BETWEEN 1 AND 128),
  dimensions INTEGER NOT NULL CHECK (
    typeof(dimensions) = 'integer' AND dimensions BETWEEN 1 AND 4096
  ),
  vector_state TEXT NOT NULL DEFAULT 'pending' CHECK (vector_state IN ('pending', 'synced', 'failed')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 24 AND julianday(updated_at) IS NOT NULL AND updated_at >= created_at
  )
);

-- Reconcile/cleanup scans for vectors that never reached the index.
CREATE INDEX idx_memory_embeddings_state ON memory_embeddings (vector_state);

-- Durable per-user cap (defense in depth for the service-level bound). The
-- trigger is the authority: concurrent inserts cannot exceed the cap.
CREATE TRIGGER memories_user_cap BEFORE INSERT ON memories
WHEN (SELECT COUNT(*) FROM memories WHERE user_id = NEW.user_id) >= 200
BEGIN
  SELECT RAISE(ABORT, 'memory capacity reached');
END;