const TOOL_CALL_MARKER = '<tool_call>';
const TOOL_CALL_END = '</tool_call>';

export interface ParsedToolCall {
  name: string;
  input: Record<string, unknown>;
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf(TOOL_CALL_MARKER, searchFrom);
    if (start === -1) break;
    const end = text.indexOf(TOOL_CALL_END, start + TOOL_CALL_MARKER.length);
    if (end === -1) break;

    const inner = text.slice(start + TOOL_CALL_MARKER.length, end).trim();
    searchFrom = end + TOOL_CALL_END.length;

    let parsed: unknown;
    try {
      parsed = JSON.parse(inner);
    } catch {
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['name'] !== 'string' || obj['name'].length === 0) continue;
    if (obj['input'] !== undefined && (typeof obj['input'] !== 'object' || obj['input'] === null || Array.isArray(obj['input']))) continue;

    calls.push({
      name: obj['name'],
      input: (obj['input'] as Record<string, unknown>) ?? {},
    });
  }

  return calls;
}

export function formatToolResultContent(content: string): string {
  return `<untrusted_tool_result>\n${content}\n</untrusted_tool_result>`;
}

export function extractTextBeforeToolCalls(text: string): string {
  const idx = text.indexOf(TOOL_CALL_MARKER);
  if (idx === -1) return text;
  return text.slice(0, idx).trim();
}
