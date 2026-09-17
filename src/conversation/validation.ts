import { MAX_MESSAGE_CHARS } from '../agent/types';

export class ConversationServiceError extends Error {
  constructor(readonly code: 'invalid_request' | 'not_found' | 'conflict' | 'internal') {
    super(`Conversation error: ${code}`);
    this.name = 'ConversationServiceError';
  }
}

export function invalid(): never {
  throw new ConversationServiceError('invalid_request');
}

export function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
  }
  return { ...value } as Record<string, unknown>;
}

export function requireUserId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function requireId(value: unknown): string {
  if (!isUuidV4(value)) invalid();
  return value;
}

export function requireTitle(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) invalid();
  return value;
}

export function requireNow(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) invalid();
  return value;
}

export function requireLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) invalid();
  return value;
}

export function requireMessage(value: unknown, keys: readonly string[] = ['role', 'content']): { role: 'system' | 'user' | 'assistant'; content: string } {
  const row = exactObject(value, keys);
  const role = row['role'];
  const inputContent = row['content'];
  if (role !== 'system' && role !== 'user' && role !== 'assistant') invalid();
  if (typeof inputContent !== 'string' || inputContent.length === 0 || inputContent.length > MAX_MESSAGE_CHARS) invalid();
  return { role, content: inputContent };
}

export async function repositoryCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ConversationServiceError) throw error;
    throw new ConversationServiceError('internal');
  }
}
