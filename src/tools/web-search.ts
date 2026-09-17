import type { ToolDefinition, ToolResult } from './types';
import { MAX_TOOL_RESULT_CHARS } from './types';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

export function createWebSearchTool(provider: SearchProvider): ToolDefinition {
  return {
    name: 'web_search',
    description: 'Search the web for current information. Returns titles, URLs, and snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        limit: { type: 'number', description: 'Max results (1-10, default 5)' },
      },
      required: ['query'],
    },
    async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { kind: 'validation_error', content: 'Input must be an object with a query field' };
      }
      const obj = input as Record<string, unknown>;
      const query = obj['query'];
      if (typeof query !== 'string' || query.trim().length === 0 || query.length > 500) {
        return { kind: 'validation_error', content: 'Query must be a non-empty string under 500 characters' };
      }
      let limit = 5;
      if (obj['limit'] !== undefined) {
        if (typeof obj['limit'] !== 'number' || !Number.isInteger(obj['limit']) || obj['limit'] < 1 || obj['limit'] > 10) {
          return { kind: 'validation_error', content: 'Limit must be an integer between 1 and 10' };
        }
        limit = obj['limit'];
      }

      try {
        const results = await provider.search(query.trim(), limit, signal);
        const formatted = results.map((r) => ({
          title: r.title.slice(0, 200),
          url: r.url.slice(0, 500),
          snippet: r.snippet.slice(0, 500),
        }));
        const content = JSON.stringify(formatted);
        if (content.length > MAX_TOOL_RESULT_CHARS) {
          return { kind: 'success', content: content.slice(0, MAX_TOOL_RESULT_CHARS) };
        }
        return { kind: 'success', content };
      } catch {
        return { kind: 'upstream_error', content: 'Search failed' };
      }
    },
  };
}
