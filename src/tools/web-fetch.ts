import type { ToolDefinition, ToolResult } from './types';
import { MAX_TOOL_RESULT_CHARS } from './types';
import { isBlockedUrl } from './ssrf';

export interface FetchProvider {
  fetch(url: string, signal?: AbortSignal): Promise<{ status: number; contentType: string; body: string }>;
}

const MAX_FETCH_CHARS = 50_000;
const ALLOWED_CONTENT_PREFIXES = ['text/html', 'text/plain', 'application/json', 'text/xml', 'application/xml'];
const MAX_REDIRECTS = 5;

export function createWebFetchTool(provider: FetchProvider): ToolDefinition {
  return {
    name: 'web_fetch',
    description: 'Fetch and extract text content from a URL. HTTPS only. Returns bounded plain text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The HTTPS URL to fetch' },
      },
      required: ['url'],
    },
    async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { kind: 'validation_error', content: 'Input must be an object with a url field' };
      }
      const obj = input as Record<string, unknown>;
      const url = obj['url'];
      if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
        return { kind: 'validation_error', content: 'URL must be a non-empty string under 2048 characters' };
      }

      if (isBlockedUrl(url)) {
        return { kind: 'blocked', content: 'URL is not allowed (must be HTTPS, no internal/private addresses)' };
      }

      try {
        const result = await fetchWithRedirectGuard(provider, url, signal);
        if (result === null) {
          return { kind: 'blocked', content: 'Redirect target was blocked or too many redirects' };
        }

        const contentType = result.contentType.toLowerCase();
        if (!ALLOWED_CONTENT_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
          return { kind: 'validation_error', content: `Unsupported content type: ${contentType}` };
        }

        const extracted = extractText(result.body, contentType);
        const bounded = extracted.slice(0, Math.min(MAX_FETCH_CHARS, MAX_TOOL_RESULT_CHARS));
        return { kind: 'success', content: bounded };
      } catch {
        return { kind: 'upstream_error', content: 'Fetch failed' };
      }
    },
  };
}

async function fetchWithRedirectGuard(
  provider: FetchProvider,
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; contentType: string; body: string } | null> {
  let currentUrl = url;
  for (let i = 0; i < MAX_REDIRECTS; i += 1) {
    if (signal?.aborted) return null;
    if (isBlockedUrl(currentUrl)) return null;
    const result = await provider.fetch(currentUrl, signal);
    if (result.status >= 300 && result.status < 400) {
      const location = extractLocationFromBody();
      if (location === null) return null;
      try {
        currentUrl = new URL(location, currentUrl).href;
      } catch {
        return null;
      }
      continue;
    }
    if (result.status < 200 || result.status >= 300) return null;
    return result;
  }
  return null;
}

function extractLocationFromBody(): string | null {
  return null;
}

function extractText(body: string, contentType: string): string {
  if (contentType.startsWith('text/html') || contentType.startsWith('text/xml') || contentType.startsWith('application/xml')) {
    return stripMarkup(body);
  }
  if (contentType.startsWith('application/json')) {
    return body.replace(/\s+/g, ' ').trim();
  }
  return body.replace(/\s+/g, ' ').trim();
}

function stripMarkup(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}
