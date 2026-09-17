CREATE TABLE conversations (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'
    AND substr(id, 15, 1) = '4' AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 200),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (typeof(last_seq) = 'integer' AND last_seq BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND julianday(updated_at) IS NOT NULL AND updated_at >= created_at),
  UNIQUE (id, user_id)
);

CREATE TABLE messages (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'
    AND substr(id, 15, 1) = '4' AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  conversation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq BETWEEN 1 AND 9007199254740991),
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL CHECK (length(content) <= 20000),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND julianday(created_at) IS NOT NULL),
  UNIQUE (conversation_id, seq),
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE
);

CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at DESC, id ASC);

CREATE TRIGGER messages_insert_guard BEFORE INSERT ON messages
BEGIN
  SELECT RAISE(ABORT, 'Invalid message state') WHERE NOT EXISTS (
    SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND user_id = NEW.user_id
      AND status = 'active' AND last_seq + 1 = NEW.seq AND updated_at <= NEW.created_at
  );
END;

CREATE TRIGGER messages_insert_touch AFTER INSERT ON messages
BEGIN
  UPDATE conversations SET last_seq = NEW.seq, updated_at = NEW.created_at
    WHERE id = NEW.conversation_id AND user_id = NEW.user_id;
END;

CREATE TRIGGER messages_delete_touch AFTER DELETE ON messages
BEGIN
  UPDATE conversations SET updated_at = max(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = OLD.conversation_id AND user_id = OLD.user_id;
END;
