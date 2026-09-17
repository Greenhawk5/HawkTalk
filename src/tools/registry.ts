import type { ToolDefinition, ToolResult } from './types';
import { MAX_TOOL_NAME_CHARS, MAX_TOOL_RESULT_CHARS, TOOL_EXECUTION_TIMEOUT_MS } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (typeof tool.name !== 'string' || tool.name.length === 0 || tool.name.length > MAX_TOOL_NAME_CHARS) {
      throw new Error('Invalid tool name');
    }
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error('Tool name must be lowercase alphanumeric with underscores, starting with a letter');
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ReadonlyArray<ToolDefinition> {
    return Array.from(this.tools.values());
  }

  async execute(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return { kind: 'validation_error', content: `Unknown tool: ${name}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOOL_EXECUTION_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await Promise.race([
        tool.execute(input, controller.signal),
        new Promise<ToolResult>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            if (signal?.aborted) reject(new Error('caller_cancelled'));
            else reject(new Error('timeout'));
          }, { once: true });
        }),
      ]);
      if (result.content.length > MAX_TOOL_RESULT_CHARS) {
        return { kind: result.kind, content: result.content.slice(0, MAX_TOOL_RESULT_CHARS) };
      }
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'timeout') {
        return { kind: 'timeout', content: `Tool '${name}' timed out` };
      }
      if (error instanceof Error && error.message === 'caller_cancelled') {
        return { kind: 'timeout', content: 'Cancelled by caller' };
      }
      return { kind: 'upstream_error', content: `Tool '${name}' failed` };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
