export type ToolResultKind = 'success' | 'validation_error' | 'timeout' | 'blocked' | 'upstream_error' | 'malformed';

export interface ToolResult {
  kind: ToolResultKind;
  content: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

export const MAX_TOOL_NAME_CHARS = 64;
export const MAX_TOOL_DESCRIPTION_CHARS = 1024;
export const MAX_TOOL_RESULT_CHARS = 10_000;
export const MAX_TOOL_ITERATIONS = 5;
export const MAX_TOOL_CALLS_PER_REQUEST = 10;
export const TOOL_EXECUTION_TIMEOUT_MS = 15_000;
export const UNTRUSTED_CONTENT_PREFIX = '<untrusted_tool_result>';
export const UNTRUSTED_CONTENT_SUFFIX = '</untrusted_tool_result>';
