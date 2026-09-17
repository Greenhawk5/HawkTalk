export interface ConversationRow {
  id: string;
  user_id: number;
  title: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: number;
  seq: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  created_at: string;
}
