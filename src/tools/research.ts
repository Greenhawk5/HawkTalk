// Phase 10 research-mode tool composition (application layer).
// Builds the bounded executor the orchestration research path consumes.
// Only the read-only web tools are ever exposed: web_search and web_fetch,
// both created through their existing factories (registry validation, result
// bounds, SSRF guard, and sanitization all unchanged). Defense in depth: the
// executor re-checks the allowlist itself, so even a misconfigured registry
// cannot smuggle another tool into research mode.
//
// Providers: web_fetch runs over the injected fetch implementation (global
// fetch in production); web_search has no configured vendor yet, so its
// provider fails closed and the tool reports upstream_error through the
// normal bounded tool-result path.

import { RESEARCH_TOOL_ALLOWLIST } from '../ai/routing-profiles';
import type { ToolDefinition } from './types';
import { createWebFetchTool } from './web-fetch';
import { createWebSearchTool } from './web-search';

export interface ResearchTools {
  names: readonly string[];
  executor: (name: string, input: unknown) => Promise<{ kind: string; content: string }>;
}

async function unavailableSearch(): Promise<never> {
  throw new Error('search_unconfigured');
}

export function buildResearchTools(fetchImpl?: typeof fetch): ResearchTools {
  const resolvedFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const fetchTool = createWebFetchTool({
    fetch: async (url: string, signal?: AbortSignal) => {
      const init: RequestInit = signal === undefined ? {} : { signal };
      const response = await resolvedFetch(url, init);
      const contentType = response.headers.get('content-type') ?? 'text/plain';
      const body = await response.text();
      return { status: response.status, contentType, body };
    },
  });
  const searchTool = createWebSearchTool({ search: unavailableSearch });
  const tools = new Map<string, ToolDefinition>([
    ['web_fetch', fetchTool],
    ['web_search', searchTool],
  ]);
  return {
    names: [...RESEARCH_TOOL_ALLOWLIST],
    executor: async (name: string, input: unknown) => {
      const tool = RESEARCH_TOOL_ALLOWLIST.has(name) ? tools.get(name) : undefined;
      if (tool === undefined) return { kind: 'validation_error', content: `Unknown tool: ${name}` };
      const result = await tool.execute(input);
      return { kind: result.kind, content: result.content };
    },
  };
}
