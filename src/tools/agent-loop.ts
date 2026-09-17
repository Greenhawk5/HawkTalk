import { runAgent } from '../agent/engine';
import type { ModelProvider } from '../agent/provider';
import type { AgentRequest } from '../agent/types';
import { MAX_SYSTEM_PROMPT_CHARS } from '../agent/types';
import type { ToolRegistry } from './registry';
import { parseToolCalls, formatToolResultContent, extractTextBeforeToolCalls } from './parser';
import { MAX_TOOL_ITERATIONS, MAX_TOOL_CALLS_PER_REQUEST } from './types';

export interface AgentLoopDeps {
  provider: ModelProvider;
  registry: ToolRegistry;
  requestId: string;
  agentUserId: string;
  model: string;
  systemPrompt: string;
}

export async function runAgentWithTools(
  initialMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  deps: AgentLoopDeps,
): Promise<string> {
  const messages = [...initialMessages];
  let totalToolCalls = 0;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const request: AgentRequest = {
      requestId: deps.requestId,
      userId: deps.agentUserId,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      config: {
        systemPrompt: deps.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS),
        model: deps.model,
      },
    };

    const response = await runAgent(request, deps.provider);
    const toolCalls = parseToolCalls(response.text);

    if (toolCalls.length === 0) {
      return response.text;
    }

    const textBefore = extractTextBeforeToolCalls(response.text);
    messages.push({ role: 'assistant', content: textBefore || response.text });

    for (const call of toolCalls) {
      if (totalToolCalls >= MAX_TOOL_CALLS_PER_REQUEST) {
        messages.push({ role: 'assistant', content: 'Maximum tool calls reached for this request.' });
        break;
      }
      totalToolCalls += 1;

      if (!deps.registry.has(call.name)) {
        messages.push({
          role: 'assistant',
          content: formatToolResultContent(`Unknown tool: ${call.name}`),
        });
        continue;
      }

      const result = await deps.registry.execute(call.name, call.input);
      messages.push({
        role: 'assistant',
        content: formatToolResultContent(result.content),
      });
    }

    if (totalToolCalls >= MAX_TOOL_CALLS_PER_REQUEST) break;
  }

  const finalRequest: AgentRequest = {
    requestId: deps.requestId,
    userId: deps.agentUserId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    config: {
      systemPrompt: deps.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS),
      model: deps.model,
    },
  };
  const finalResponse = await runAgent(finalRequest, deps.provider);
  return extractTextBeforeToolCalls(finalResponse.text) || finalResponse.text;
}
