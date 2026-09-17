-- Phase 6: Application orchestration — durable processing states and default conversations.
-- Extends processed_updates with a processing state machine to prevent duplicate AI generation.
-- Adds default_conversations mapping for per-user active conversation resolution.
-- SQLite ALTER TABLE does not support CHECK/REFERENCES on added columns; integrity is
-- enforced by the repository layer and application code.

ALTER TABLE processed_updates ADD COLUMN processing_state TEXT NOT NULL DEFAULT 'claimed';
ALTER TABLE processed_updates ADD COLUMN conversation_id TEXT;
ALTER TABLE processed_updates ADD COLUMN assistant_message_id TEXT;

CREATE TABLE default_conversations (
  user_id INTEGER NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  UNIQUE (user_id, conversation_id)
);
