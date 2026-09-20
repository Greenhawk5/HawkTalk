var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/env.ts
function validateEnv(env) {
  if (!["development", "staging", "production"].includes(env.APP_ENV ?? "") || !env.DB || typeof env.DB.prepare !== "function") {
    throw new Error("Invalid environment configuration");
  }
}
__name(validateEnv, "validateEnv");

// src/conversation/clock.ts
var RuntimeClock = class {
  static {
    __name(this, "RuntimeClock");
  }
  now() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
};

// src/db/admission-d1.ts
var D1AdmissionGate = class {
  constructor(db, clock = new RuntimeClock()) {
    this.db = db;
    this.clock = clock;
  }
  db;
  clock;
  static {
    __name(this, "D1AdmissionGate");
  }
  async admit(userId, updateId) {
    const now = Math.floor(Date.parse(this.clock.now()) / 1e3);
    if (!Number.isSafeInteger(now) || now < 0) return "unavailable";
    const day = Math.floor(now / 86400) * 86400;
    const hour = Math.floor(now / 3600) * 3600;
    const statements = [
      this.db.prepare(`
        INSERT INTO request_admissions (update_id, user_id, admitted_at, decision, quota_units, rate_units)
        SELECT ?, ?, ?, decision,
          CASE WHEN decision = 'allowed' THEN 1 ELSE 0 END,
          CASE WHEN decision IN ('allowed', 'quota_exceeded') THEN 1 ELSE 0 END
        FROM (
          SELECT CASE
            WHEN u.role = 'BLOCKED' OR u.status != 'active' THEN 'blocked'
            WHEN p.bypass_rate = 0 AND (
              COALESCE((SELECT SUM(rate_units) FROM request_admissions WHERE user_id = u.id AND admitted_at >= ? AND admitted_at < ?), 0) >= p.per_second
              OR COALESCE((SELECT SUM(rate_units) FROM request_admissions WHERE user_id = u.id AND admitted_at >= ? AND admitted_at < ?), 0) >= p.per_hour
            ) THEN 'rate_limited'
            WHEN p.bypass_quota = 0 AND
              COALESCE((SELECT SUM(quota_units) FROM request_admissions WHERE user_id = u.id AND admitted_at >= ? AND admitted_at < ?), 0) >= p.daily_messages
              THEN 'quota_exceeded'
            ELSE 'allowed'
          END AS decision
          FROM users u JOIN admission_policies p ON p.role = u.role
          JOIN processed_updates r ON r.telegram_user_id = u.telegram_user_id
          WHERE u.id = ? AND r.update_id = ? AND r.kind = 'text' AND r.processing_state = 'claimed'
        ) WHERE true
        ON CONFLICT (update_id) DO NOTHING
      `).bind(updateId, userId, now, now, now + 1, hour, hour + 3600, day, day + 86400, userId, updateId),
      this.db.prepare(`
        SELECT CASE WHEN u.role = 'BLOCKED' OR u.status != 'active' THEN 'blocked' ELSE a.decision END AS decision
        FROM request_admissions a JOIN users u ON u.id = a.user_id
        JOIN processed_updates r ON r.telegram_user_id = u.telegram_user_id AND r.update_id = a.update_id
        WHERE a.update_id = ? AND a.user_id = ?
      `).bind(updateId, userId)
    ];
    const results = await this.db.batch(statements);
    return results[1]?.results[0]?.decision ?? "unavailable";
  }
};

// src/db/telegram.ts
async function upsertTelegramUser(db, input, now, ownerTelegramId) {
  const isOwner = typeof ownerTelegramId === "string" && ownerTelegramId.length > 0 && String(input.telegramUserId) === ownerTelegramId;
  if (isOwner) {
    await db.prepare(
      `INSERT INTO users (telegram_user_id, username, display_name, role, status, created_at, updated_at, last_seen)
         VALUES (?, ?, ?, 'OWNER', 'active', ?, ?, ?)
         ON CONFLICT (telegram_user_id) DO UPDATE SET
           username = excluded.username,
           display_name = excluded.display_name,
           role = CASE WHEN excluded.role = 'OWNER' THEN 'OWNER' ELSE users.role END,
           updated_at = excluded.updated_at,
           last_seen = excluded.last_seen`
    ).bind(input.telegramUserId, input.username, input.displayName, now, now, now).run();
  } else {
    await db.prepare(
      `INSERT INTO users (telegram_user_id, username, display_name, role, status, created_at, updated_at, last_seen)
         VALUES (?, ?, ?, 'USER', 'active', ?, ?, ?)
         ON CONFLICT (telegram_user_id) DO UPDATE SET
           username = excluded.username,
           display_name = excluded.display_name,
           updated_at = excluded.updated_at,
           last_seen = excluded.last_seen`
    ).bind(input.telegramUserId, input.username, input.displayName, now, now, now).run();
  }
}
__name(upsertTelegramUser, "upsertTelegramUser");
async function getTelegramUserRole(db, telegramUserId) {
  const row = await db.prepare("SELECT role FROM users WHERE telegram_user_id = ?").bind(telegramUserId).first();
  return row?.role ?? null;
}
__name(getTelegramUserRole, "getTelegramUserRole");
async function claimUpdate(db, updateId, telegramUserId, kind, now) {
  const result = await db.prepare("INSERT INTO processed_updates (update_id, telegram_user_id, kind, received_at) VALUES (?, ?, ?, ?) ON CONFLICT (update_id) DO NOTHING").bind(updateId, telegramUserId, kind, now).run();
  return (result.meta.changes ?? 0) > 0;
}
__name(claimUpdate, "claimUpdate");
async function releaseUpdateClaim(db, updateId) {
  await db.prepare("DELETE FROM processed_updates WHERE update_id = ? AND processing_state = 'claimed'").bind(updateId).run();
}
__name(releaseUpdateClaim, "releaseUpdateClaim");

// src/db/users.ts
async function findInternalUserIdByTelegramId(db, telegramUserId) {
  const row = await db.prepare("SELECT id FROM users WHERE telegram_user_id = ?").bind(telegramUserId).first();
  return row?.id ?? null;
}
__name(findInternalUserIdByTelegramId, "findInternalUserIdByTelegramId");

// src/orchestration/admission.ts
function admissionReply(decision) {
  switch (decision) {
    case "quota_exceeded":
      return "Your message allowance has been reached. Please try again tomorrow.";
    case "rate_limited":
      return "Please slow down and try again later.";
    case "blocked":
      return "This account cannot use the assistant.";
    case "unavailable":
      return "The assistant is temporarily unavailable. Please try again later.";
  }
}
__name(admissionReply, "admissionReply");

// src/agent/errors.ts
var AGENT_ERROR_MESSAGES = {
  invalid_request: "Invalid agent request",
  provider_unavailable: "Model provider unavailable",
  provider_timeout: "Model provider timed out",
  provider_failure: "Model provider failed",
  provider_malformed: "Model provider returned an invalid result",
  internal: "Internal agent failure"
};
var AgentError = class extends Error {
  static {
    __name(this, "AgentError");
  }
  code;
  constructor(code) {
    super(AGENT_ERROR_MESSAGES[code]);
    this.name = "AgentError";
    this.code = code;
  }
};
var ProviderError = class extends Error {
  static {
    __name(this, "ProviderError");
  }
  code;
  httpStatus;
  phase;
  detail;
  contentType;
  constructor(code, httpStatus, meta) {
    super(`Provider error: ${code}`);
    this.name = "ProviderError";
    this.code = code;
    if (httpStatus !== void 0) this.httpStatus = httpStatus;
    if (meta?.phase !== void 0) this.phase = meta.phase;
    if (meta?.detail !== void 0) this.detail = meta.detail;
    if (meta?.contentType !== void 0) this.contentType = meta.contentType;
  }
};
var PROVIDER_TO_AGENT = {
  unavailable: "provider_unavailable",
  timeout: "provider_timeout",
  upstream: "provider_failure",
  malformed: "provider_malformed"
};
function toAgentError(error) {
  if (error instanceof AgentError) return error;
  if (error instanceof ProviderError) return new AgentError(PROVIDER_TO_AGENT[error.code]);
  return new AgentError("internal");
}
__name(toAgentError, "toAgentError");

// src/agent/types.ts
var MAX_REQUEST_ID_CHARS = 128;
var MAX_USER_ID_CHARS = 128;
var MAX_MESSAGES = 100;
var MAX_MESSAGE_CHARS = 2e4;
var MAX_TOTAL_CONTENT_CHARS = 1e5;
var MAX_SYSTEM_PROMPT_CHARS = 8e3;
var MAX_MODEL_ID_CHARS = 128;
var DEFAULT_OUTPUT_TOKENS = 1024;
var MAX_OUTPUT_TOKENS = 16384;
var MIN_TEMPERATURE = 0;
var MAX_TEMPERATURE = 2;
var MAX_METADATA_KEYS = 16;
var MAX_METADATA_KEY_CHARS = 64;
var MAX_PROVIDER_TEXT_CHARS = 2e5;

// src/agent/engine.ts
var DEFAULT_PROVIDER_TIMEOUT_MS = 3e4;
var MAX_PROVIDER_TIMEOUT_MS = 3e5;
function fail() {
  throw new AgentError("invalid_request");
}
__name(fail, "fail");
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
__name(isPlainObject, "isPlainObject");
function boundedId(value, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail();
  return value;
}
__name(boundedId, "boundedId");
function validateMetadata(value) {
  if (value === void 0) return void 0;
  if (!isPlainObject(value)) fail();
  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS) fail();
  const out = {};
  for (const key of keys) {
    if (key.length === 0 || key.length > MAX_METADATA_KEY_CHARS) fail();
    if (key === "__proto__" || key === "constructor" || key === "prototype") fail();
    const entry = value[key];
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") fail();
    out[key] = entry;
  }
  return out;
}
__name(validateMetadata, "validateMetadata");
function validateMessage(value) {
  if (!isPlainObject(value)) fail();
  const role = value["role"];
  if (role !== "system" && role !== "user" && role !== "assistant") fail();
  const content = value["content"];
  if (typeof content !== "string" || content.length > MAX_MESSAGE_CHARS) fail();
  const metadata = validateMetadata(value["metadata"]);
  const message = { role, content };
  if (metadata !== void 0) message.metadata = metadata;
  return message;
}
__name(validateMessage, "validateMessage");
function validateConfig(value) {
  if (!isPlainObject(value)) fail();
  const systemPrompt = value["systemPrompt"];
  if (typeof systemPrompt !== "string" || systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) fail();
  const model = boundedId(value["model"], MAX_MODEL_ID_CHARS);
  const config = { systemPrompt, model };
  const maxOutputTokens = value["maxOutputTokens"];
  if (maxOutputTokens !== void 0) {
    if (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > MAX_OUTPUT_TOKENS) fail();
    config.maxOutputTokens = maxOutputTokens;
  }
  const temperature = value["temperature"];
  if (temperature !== void 0) {
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < MIN_TEMPERATURE || temperature > MAX_TEMPERATURE) fail();
    config.temperature = temperature;
  }
  return config;
}
__name(validateConfig, "validateConfig");
function validateAgentRequest(request) {
  if (!isPlainObject(request)) fail();
  const requestId = boundedId(request["requestId"], MAX_REQUEST_ID_CHARS);
  const userId = boundedId(request["userId"], MAX_USER_ID_CHARS);
  if (!Array.isArray(request["messages"])) fail();
  const messages = request["messages"];
  if (messages.length === 0 || messages.length > MAX_MESSAGES) fail();
  const validatedMessages = messages.map(validateMessage);
  const config = validateConfig(request["config"]);
  let totalChars = config.systemPrompt.length;
  for (const message of validatedMessages) totalChars += message.content.length;
  if (totalChars > MAX_TOTAL_CONTENT_CHARS) fail();
  return { requestId, userId, messages: validatedMessages, config };
}
__name(validateAgentRequest, "validateAgentRequest");
function buildProviderMessages(request) {
  const out = [];
  if (request.config.systemPrompt.length > 0) {
    out.push({ role: "system", content: request.config.systemPrompt });
  }
  for (const message of request.messages) {
    if (message.content.length === 0) continue;
    out.push({ role: message.role, content: message.content });
  }
  if (out.length === 0) throw new AgentError("invalid_request");
  return out;
}
__name(buildProviderMessages, "buildProviderMessages");
function normalizeResult(requestId, result) {
  if (!isPlainObject(result)) throw new AgentError("provider_malformed");
  const text = result["text"];
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_PROVIDER_TEXT_CHARS) {
    throw new AgentError("provider_malformed");
  }
  const model = result["model"];
  if (typeof model !== "string" || model.length === 0 || model.length > MAX_MODEL_ID_CHARS) {
    throw new AgentError("provider_malformed");
  }
  const response = { requestId, text, model };
  const usage = result["usage"];
  if (usage !== void 0) {
    if (!isPlainObject(usage)) throw new AgentError("provider_malformed");
    const normalized = {};
    for (const key of ["inputTokens", "outputTokens"]) {
      const tokens = usage[key];
      if (tokens !== void 0) {
        if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 0) throw new AgentError("provider_malformed");
        normalized[key] = tokens;
      }
    }
    response.usage = normalized;
  }
  return response;
}
__name(normalizeResult, "normalizeResult");
function validateProvider(provider) {
  if (typeof provider !== "object" || provider === null || typeof provider.generate !== "function" || typeof provider.id !== "string" || provider.id.length === 0) {
    throw new AgentError("internal");
  }
  return provider;
}
__name(validateProvider, "validateProvider");
async function runAgent(request, provider, options = {}) {
  const validated = validateAgentRequest(request);
  const modelProvider = validateProvider(provider);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_PROVIDER_TIMEOUT_MS) {
    throw new AgentError("invalid_request");
  }
  const messages = buildProviderMessages(validated);
  const input = {
    requestId: validated.requestId,
    model: validated.config.model,
    systemPrompt: validated.config.systemPrompt,
    messages,
    maxOutputTokens: validated.config.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS
  };
  if (validated.config.temperature !== void 0) input.temperature = validated.config.temperature;
  const controller = new AbortController();
  input.signal = controller.signal;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AgentError("provider_timeout"));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([modelProvider.generate(input), timeout]);
    if (timer !== void 0) clearTimeout(timer);
    return normalizeResult(validated.requestId, result);
  } catch (error) {
    if (timer !== void 0) clearTimeout(timer);
    throw toAgentError(error);
  }
}
__name(runAgent, "runAgent");

// src/tools/parser.ts
var TOOL_CALL_MARKER = "<tool_call>";
var TOOL_CALL_END = "</tool_call>";
function parseToolCalls(text) {
  const calls = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf(TOOL_CALL_MARKER, searchFrom);
    if (start === -1) break;
    const end = text.indexOf(TOOL_CALL_END, start + TOOL_CALL_MARKER.length);
    if (end === -1) break;
    const inner = text.slice(start + TOOL_CALL_MARKER.length, end).trim();
    searchFrom = end + TOOL_CALL_END.length;
    let parsed;
    try {
      parsed = JSON.parse(inner);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const obj = parsed;
    if (typeof obj["name"] !== "string" || obj["name"].length === 0) continue;
    if (obj["input"] !== void 0 && (typeof obj["input"] !== "object" || obj["input"] === null || Array.isArray(obj["input"]))) continue;
    calls.push({
      name: obj["name"],
      input: obj["input"] ?? {}
    });
  }
  return calls;
}
__name(parseToolCalls, "parseToolCalls");
function formatToolResultContent(content) {
  return `<untrusted_tool_result>
${content}
</untrusted_tool_result>`;
}
__name(formatToolResultContent, "formatToolResultContent");
function extractTextBeforeToolCalls(text) {
  const idx = text.indexOf(TOOL_CALL_MARKER);
  if (idx === -1) return text;
  return text.slice(0, idx).trim();
}
__name(extractTextBeforeToolCalls, "extractTextBeforeToolCalls");

// src/tools/types.ts
var MAX_TOOL_NAME_CHARS = 64;
var MAX_TOOL_RESULT_CHARS = 1e4;
var MAX_TOOL_ITERATIONS = 5;
var MAX_TOOL_CALLS_PER_REQUEST = 10;
var TOOL_EXECUTION_TIMEOUT_MS = 15e3;

// src/tools/agent-loop.ts
async function runAgentWithTools(initialMessages, deps) {
  const messages = [...initialMessages];
  let totalToolCalls = 0;
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const request = {
      requestId: deps.requestId,
      userId: deps.agentUserId,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      config: {
        systemPrompt: deps.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS),
        model: deps.model
      }
    };
    const response = await runAgent(request, deps.provider);
    const toolCalls = parseToolCalls(response.text);
    if (toolCalls.length === 0) {
      return response.text;
    }
    const textBefore = extractTextBeforeToolCalls(response.text);
    messages.push({ role: "assistant", content: textBefore || response.text });
    for (const call of toolCalls) {
      if (totalToolCalls >= MAX_TOOL_CALLS_PER_REQUEST) {
        messages.push({ role: "assistant", content: "Maximum tool calls reached for this request." });
        break;
      }
      totalToolCalls += 1;
      if (!deps.registry.has(call.name)) {
        messages.push({
          role: "assistant",
          content: formatToolResultContent(`Unknown tool: ${call.name}`)
        });
        continue;
      }
      const result = await deps.registry.execute(call.name, call.input);
      messages.push({
        role: "assistant",
        content: formatToolResultContent(result.content)
      });
    }
    if (totalToolCalls >= MAX_TOOL_CALLS_PER_REQUEST) break;
  }
  const finalRequest = {
    requestId: deps.requestId,
    userId: deps.agentUserId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    config: {
      systemPrompt: deps.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS),
      model: deps.model
    }
  };
  const finalResponse = await runAgent(finalRequest, deps.provider);
  return extractTextBeforeToolCalls(finalResponse.text) || finalResponse.text;
}
__name(runAgentWithTools, "runAgentWithTools");

// src/tools/registry.ts
var ToolRegistry = class {
  static {
    __name(this, "ToolRegistry");
  }
  tools = /* @__PURE__ */ new Map();
  register(tool) {
    if (typeof tool.name !== "string" || tool.name.length === 0 || tool.name.length > MAX_TOOL_NAME_CHARS) {
      throw new Error("Invalid tool name");
    }
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error("Tool name must be lowercase alphanumeric with underscores, starting with a letter");
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }
  get(name) {
    return this.tools.get(name);
  }
  has(name) {
    return this.tools.has(name);
  }
  list() {
    return Array.from(this.tools.values());
  }
  async execute(name, input, signal) {
    const tool = this.tools.get(name);
    if (tool === void 0) {
      return { kind: "validation_error", content: `Unknown tool: ${name}` };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOOL_EXECUTION_TIMEOUT_MS);
    const onAbort = /* @__PURE__ */ __name(() => controller.abort(), "onAbort");
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await Promise.race([
        tool.execute(input, controller.signal),
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => {
            if (signal?.aborted) reject(new Error("caller_cancelled"));
            else reject(new Error("timeout"));
          }, { once: true });
        })
      ]);
      if (result.content.length > MAX_TOOL_RESULT_CHARS) {
        return { kind: result.kind, content: result.content.slice(0, MAX_TOOL_RESULT_CHARS) };
      }
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "timeout") {
        return { kind: "timeout", content: `Tool '${name}' timed out` };
      }
      if (error instanceof Error && error.message === "caller_cancelled") {
        return { kind: "timeout", content: "Cancelled by caller" };
      }
      return { kind: "upstream_error", content: `Tool '${name}' failed` };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
};

// src/ai/routing-profiles.ts
function isRoutingProfile(value) {
  return value === "FAST" || value === "DEFAULT" || value === "COMPLEX" || value === "RESEARCH";
}
__name(isRoutingProfile, "isRoutingProfile");
var ROUTING_PROFILE_INFO = {
  FAST: { label: "\u26A1 Fast", description: "Cheapest enabled provider; short answers" },
  DEFAULT: { label: "\u{1F916} Default", description: "Highest-weight enabled provider" },
  COMPLEX: { label: "\u{1F9E0} Complex", description: "Deterministic strongest provider; longer budget" },
  RESEARCH: { label: "\u{1F50D} Research", description: "Strongest provider with web tools enabled" }
};
function resolveRoutingProfile(profile, inputs) {
  const normalized = isRoutingProfile(profile) ? profile : "DEFAULT";
  const requested = inputs.model;
  if (normalized === "DEFAULT" || normalized === "RESEARCH") {
    const outputMultiplier = normalized === "RESEARCH" ? 2 : 1;
    const enableWebTools = normalized === "RESEARCH";
    if (requested === "router") {
      const enabled2 = [...inputs.providers].filter((entry) => entry.enabled).sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const pick2 = enabled2[0];
      if (pick2 !== void 0) {
        return { profile: normalized, model: `${pick2.id}:`, outputMultiplier, enableWebTools };
      }
    }
    return { profile: normalized, model: requested, outputMultiplier, enableWebTools };
  }
  const separator = requested.indexOf(":");
  if (separator > 0 && /^[a-z0-9-]+$/.test(requested.slice(0, separator))) {
    return { profile: normalized, model: requested, outputMultiplier: 1, enableWebTools: false };
  }
  const enabled = [...inputs.providers].filter((entry) => entry.enabled).sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (enabled.length === 0) {
    return { profile: normalized, model: requested, outputMultiplier: normalized === "COMPLEX" ? 2 : 1, enableWebTools: false };
  }
  const pick = normalized === "FAST" ? enabled[enabled.length - 1] : enabled[0];
  return { profile: normalized, model: `${pick.id}:${requested}`, outputMultiplier: normalized === "COMPLEX" ? 2 : 1, enableWebTools: false };
}
__name(resolveRoutingProfile, "resolveRoutingProfile");
var RESEARCH_TOOL_ALLOWLIST = /* @__PURE__ */ new Set(["web_search", "web_fetch"]);
function researchToolNames(registered) {
  return registered.filter((name) => RESEARCH_TOOL_ALLOWLIST.has(name)).slice(0, 8);
}
__name(researchToolNames, "researchToolNames");

// src/orchestration/service.ts
var ORCHESTRATION_HISTORY_LIMIT = 20;
var PRE_GENERATION_ERROR_KINDS = ["conversation_failed"];
var ConversationFlowError = class extends Error {
  static {
    __name(this, "ConversationFlowError");
  }
  kind;
  constructor(kind) {
    super(`Conversation flow error: ${kind}`);
    this.name = "ConversationFlowError";
    this.kind = kind;
  }
};
async function handleUserTextMessage(updateId, text, deps) {
  const { orchestrator, processing } = deps;
  const decision = await deps.admission.admit(deps.userId, updateId).catch(() => "unavailable");
  if (decision !== "allowed") {
    return { state: "rejected", assistantText: admissionReply(decision), decision };
  }
  const { conversation } = await orchestrator.resolveDefaultConversation(deps.userId).catch(() => {
    throw new ConversationFlowError("conversation_failed");
  });
  const marked = await processing.markGenerating(updateId, conversation.id).catch(() => false);
  if (!marked) {
    const reused = await getCompletedAssistantText(updateId, deps).catch(() => null);
    if (reused !== null) return { state: "reused", assistantText: reused };
    throw new ConversationFlowError("generating_mark_failed");
  }
  await orchestrator.appendMessage(deps.userId, conversation.id, { role: "user", content: text }).catch(() => {
    throw new ConversationFlowError("user_message_failed");
  });
  const history = await orchestrator.getContext(deps.userId, conversation.id, ORCHESTRATION_HISTORY_LIMIT).catch(() => {
    throw new ConversationFlowError("history_failed");
  });
  const providers = await listProvidersForRouting(deps).catch(() => []);
  const routing = resolveRoutingProfile(deps.routingProfile, { model: deps.model, providers });
  const memoryBlock = deps.memoryRecall === void 0 ? "" : await deps.memoryRecall(text).catch(() => "");
  const toolMessages = memoryBlock.length === 0 ? history : [...history.slice(0, -1), { role: history[history.length - 1]?.role ?? "user", content: `${history[history.length - 1]?.content ?? text}

${memoryBlock}` }];
  let assistantText;
  let agentResponse = null;
  try {
    if (routing.enableWebTools && deps.researchTools !== void 0) {
      const registry = new ToolRegistry();
      for (const name of researchToolNames(deps.researchTools.names)) {
        registry.register({ name, description: `${name} (research mode)`, inputSchema: {}, execute: /* @__PURE__ */ __name((input) => deps.researchTools?.executor(name, input).then((result) => ({ kind: "success", content: result.content })) ?? Promise.resolve({ kind: "upstream_error", content: `${name} unavailable` }), "execute") });
      }
      assistantText = await runAgentWithTools(toolMessages, {
        provider: deps.provider,
        registry,
        requestId: deps.requestId,
        agentUserId: deps.agentUserId,
        model: routing.model,
        systemPrompt: deps.systemPrompt
      });
    } else {
      agentResponse = await runAgent(buildAgentRequest(deps, toolMessages, routing), deps.provider);
      assistantText = agentResponse.text;
    }
  } catch (agentError) {
    const diag = agentError instanceof Error ? {
      name: agentError.name,
      message: String(agentError.message).replace(/[^\x20-\x7E]/g, "?").slice(0, 120),
      ..."code" in agentError && typeof agentError.code === "string" ? { code: agentError.code } : {},
      ..."httpStatus" in agentError && typeof agentError.httpStatus === "number" ? { http_status: agentError.httpStatus } : {},
      ..."phase" in agentError && typeof agentError.phase === "string" ? { failure_phase: agentError.phase } : {},
      ..."detail" in agentError && typeof agentError.detail === "string" ? { detail: String(agentError.detail).slice(0, 200) } : {}
    } : { name: typeof agentError };
    console.error(JSON.stringify({ event: "agent_stage_failed", request_id: deps.requestId, ...diag }));
    await processing.markFailed(updateId).catch(() => void 0);
    throw new ConversationFlowError("agent_failed");
  }
  if (deps.usageRecorder !== void 0) {
    const usage = extractAgentUsage(agentResponse);
    if (usage !== null) {
      await deps.usageRecorder.record({
        providerId: usage.providerId,
        vendorModel: usage.vendorModel,
        requestId: deps.requestId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens
      }).catch(() => void 0);
    }
  }
  const assistant = await orchestrator.appendMessage(deps.userId, conversation.id, { role: "assistant", content: assistantText }).catch(() => {
    throw new ConversationFlowError("assistant_message_failed");
  });
  const completed = await processing.completeWithAssistantMessage(updateId, assistant.id).catch(() => false);
  if (!completed) throw new ConversationFlowError("completion_mark_failed");
  return { state: "completed", assistantText };
}
__name(handleUserTextMessage, "handleUserTextMessage");
function buildAgentRequest(deps, history, routing) {
  return {
    requestId: deps.requestId,
    userId: deps.agentUserId,
    messages: history,
    config: {
      systemPrompt: deps.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS),
      model: routing?.model ?? deps.model,
      maxOutputTokens: routing?.outputMultiplier === 2 ? DEFAULT_OUTPUT_TOKENS * 2 : void 0
    }
  };
}
__name(buildAgentRequest, "buildAgentRequest");
async function listProvidersForRouting(deps) {
  const snapshot = deps.directorySnapshot;
  if (snapshot === void 0) return [];
  const entries = await snapshot.listRoutingProviders().catch(() => []);
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(entry.id)) continue;
    out.push({
      id: entry.id,
      enabled: entry.enabled === true,
      weight: typeof entry.weight === "number" && Number.isSafeInteger(entry.weight) ? entry.weight : 0
    });
  }
  return out;
}
__name(listProvidersForRouting, "listProvidersForRouting");
function extractAgentUsage(response) {
  if (response === null || response === void 0) return null;
  const usage = response.usage;
  if (usage === void 0) return null;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) return null;
  const separator = response.model.indexOf(":");
  const providerId = separator > 0 ? response.model.slice(0, separator) : "unknown";
  if (!/^[a-z0-9-]{1,64}$/.test(providerId)) return null;
  return { providerId, vendorModel: response.model.slice(0, 128), inputTokens, outputTokens };
}
__name(extractAgentUsage, "extractAgentUsage");
async function getCompletedAssistantText(updateId, deps) {
  const record = await deps.processing.getProcessingRecord(updateId).catch(() => null);
  if (record === null || record.state !== "completed") return null;
  if (record.conversationId === null || record.assistantMessageId === null) return null;
  return deps.orchestrator.getMessageText(deps.userId, record.conversationId, record.assistantMessageId).catch(() => null);
}
__name(getCompletedAssistantText, "getCompletedAssistantText");

// src/telegram/client.ts
var TELEGRAM_API_BASE = "https://api.telegram.org";
var TELEGRAM_SEND_TIMEOUT_MS = 1e4;
var MAX_SEND_ATTEMPTS = 2;
var MAX_MESSAGE_CHARS2 = 4096;
var TelegramSendError = class extends Error {
  static {
    __name(this, "TelegramSendError");
  }
  constructor(message) {
    super(message);
  }
};
function isRetryableFailure(error) {
  if (error instanceof TypeError) return true;
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
__name(isRetryableFailure, "isRetryableFailure");
function isApiResponse(value) {
  return typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean";
}
__name(isApiResponse, "isApiResponse");
async function sendTelegramMessage(options) {
  const { token, chatId, timeoutMs = TELEGRAM_SEND_TIMEOUT_MS } = options;
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const text = options.text.length > MAX_MESSAGE_CHARS2 ? `${options.text.slice(0, MAX_MESSAGE_CHARS2 - 1)}\u2026` : options.text;
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text };
  if (options.replyMarkup !== void 0) body["reply_markup"] = options.replyMarkup;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) throw new TelegramSendError("Telegram request failed");
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw new TelegramSendError("Telegram response invalid");
      }
      if (!isApiResponse(payload) || payload.ok !== true) throw new TelegramSendError("Telegram API error");
      clearTimeout(timer);
      return;
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof TelegramSendError) throw error;
      if (attempt >= MAX_SEND_ATTEMPTS || !isRetryableFailure(error)) {
        throw new TelegramSendError("Telegram request failed");
      }
    }
  }
  throw new TelegramSendError("Telegram request failed");
}
__name(sendTelegramMessage, "sendTelegramMessage");
async function answerCallbackQuery(options) {
  const { token, callbackQueryId, timeoutMs = TELEGRAM_SEND_TIMEOUT_MS } = options;
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const url = `${TELEGRAM_API_BASE}/bot${token}/answerCallbackQuery`;
  const body = { callback_query_id: callbackQueryId };
  if (typeof options.text === "string" && options.text.length > 0) {
    body["text"] = options.text.length > 200 ? options.text.slice(0, 199) + "\u2026" : options.text;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new TelegramSendError("Telegram request failed");
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramSendError("Telegram response invalid");
    }
    if (!isApiResponse(payload) || payload.ok !== true) throw new TelegramSendError("Telegram API error");
  } finally {
    clearTimeout(timer);
  }
}
__name(answerCallbackQuery, "answerCallbackQuery");

// src/telegram/parser.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function isSafeIntegerId(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
__name(isSafeIntegerId, "isSafeIntegerId");
function optionalText(value) {
  return typeof value === "string" ? value : null;
}
__name(optionalText, "optionalText");
function parseTelegramUpdate(payload) {
  if (!isRecord(payload)) return null;
  if (!isSafeIntegerId(payload["update_id"])) return null;
  const updateId = payload["update_id"];
  const message = payload["message"];
  if (isRecord(message)) {
    const from = message["from"];
    const chat = message["chat"];
    const text = message["text"];
    if (isRecord(from) && typeof from["id"] === "number" && Number.isInteger(from["id"]) && from["id"] > 0 && isRecord(chat) && typeof chat["id"] === "number" && Number.isInteger(chat["id"]) && typeof text === "string") {
      const firstName = optionalText(from["first_name"]);
      const lastName = optionalText(from["last_name"]);
      const displayName = [firstName, lastName].filter((part) => part !== null).join(" ") || null;
      return {
        kind: "text_message",
        updateId,
        userId: from["id"],
        chatId: chat["id"],
        chatType: optionalText(chat["type"]) ?? "unknown",
        text,
        username: optionalText(from["username"]),
        displayName
      };
    }
  }
  const callbackQuery = payload["callback_query"];
  if (isRecord(callbackQuery)) {
    const from = callbackQuery["from"];
    const message2 = callbackQuery["message"];
    const data = callbackQuery["data"];
    if (isRecord(from) && typeof from["id"] === "number" && Number.isInteger(from["id"]) && from["id"] > 0 && isRecord(message2) && isRecord(message2["chat"]) && typeof message2["chat"]["id"] === "number" && Number.isInteger(message2["chat"]["id"]) && typeof data === "string" && data.length > 0 && data.length <= 64 && typeof callbackQuery["id"] === "string" && callbackQuery["id"].length > 0 && callbackQuery["id"].length <= 128) {
      return {
        kind: "admin_callback",
        updateId,
        callbackQueryId: callbackQuery["id"],
        userId: from["id"],
        chatId: message2["chat"]["id"],
        chatType: optionalText(message2["chat"]["type"]) ?? "unknown",
        data
      };
    }
  }
  return { kind: "unsupported", updateId };
}
__name(parseTelegramUpdate, "parseTelegramUpdate");

// src/telegram/ack.ts
var TRANSPORT_ACK_TEXT = "HawkTalk received your message. Conversational replies arrive with the Agent Core (Phase 3).";

// src/admin/errors.ts
var AdminError = class extends Error {
  static {
    __name(this, "AdminError");
  }
  kind;
  constructor(kind, message) {
    super(message);
    this.name = "AdminError";
    this.kind = kind;
  }
};
var ADMIN_ERROR_TEXT = {
  not_authorized: "You are not authorized to use admin commands.",
  not_found: "That item no longer exists.",
  validation_failed: "That value is invalid. Check the format and try again.",
  storage_failed: "The admin service is temporarily unavailable. Try again later.",
  conflict: "The item changed since you loaded it. Reload and try again."
};
function adminErrorText(kind) {
  return ADMIN_ERROR_TEXT[kind];
}
__name(adminErrorText, "adminErrorText");

// src/telegram/admin-ui.ts
var ADMIN_COMMAND = "/admin";
var MAX_PAGE_CHARS = 3800;
var CALLBACK_ACTIONS = /* @__PURE__ */ new Set(["menu", "dashboard", "users", "user", "policy", "providers", "provider", "audit", "tools", "credentials", "provtog", "credtog", "credask", "confirm", "urole", "ustat", "usage", "routing", "addprov", "editprov", "addcred"]);
var SAFE_ID = /^[a-z0-9-]{1,64}$/;
var ROLES = /* @__PURE__ */ new Set(["OWNER", "ADMIN", "VIP", "USER", "BLOCKED"]);
var STATUSES = /* @__PURE__ */ new Set(["active", "blocked"]);
var CONFIRMATION_ID = /^[a-f0-9]{32}$/;
var SAFE_NUMERIC = /^[1-9][0-9]*$/;
function numericArg(arg) {
  if (arg === void 0 || !SAFE_NUMERIC.test(arg) || !Number.isSafeInteger(Number(arg))) return null;
  return Number(arg);
}
__name(numericArg, "numericArg");
function parseAdminCallback(data) {
  if (typeof data !== "string" || data.length === 0 || data.length > 64 || !data.startsWith("a:")) return null;
  const parts = data.split(":");
  const action = parts[1];
  const arg = parts[2];
  if (action === void 0 || !CALLBACK_ACTIONS.has(action)) return null;
  switch (action) {
    case "menu":
    case "dashboard":
    case "providers":
    case "tools":
    case "usage":
    case "routing":
      return parts.length === 2 ? { action } : null;
    case "users":
    case "audit": {
      if (parts.length === 2) return { action, cursor: null };
      if (parts.length !== 3) return null;
      const cursor = numericArg(arg);
      return cursor === null ? null : { action, cursor };
    }
    case "user": {
      const userId = numericArg(arg);
      return parts.length === 3 && userId !== null ? { action, userId } : null;
    }
    case "policy": {
      if (parts.length !== 3 || arg === void 0 || !ROLES.has(arg)) return null;
      return { action, role: arg };
    }
    case "provider": {
      if (parts.length !== 3 || arg === void 0 || !SAFE_ID.test(arg)) return null;
      return { action, providerId: arg };
    }
    case "credentials": {
      if (parts.length !== 3 || arg === void 0 || !SAFE_ID.test(arg)) return null;
      return { action, providerId: arg };
    }
    case "provtog":
    case "credtog": {
      if (parts.length !== 4 || arg === void 0 || !SAFE_ID.test(arg) || !STATUSES.has(parts[3] ?? "")) return null;
      const enabled = parts[3] === "on";
      return action === "provtog" ? { action, providerId: arg, enabled } : { action, credentialId: arg, enabled };
    }
    case "credask": {
      if (parts.length !== 3 || arg === void 0 || !SAFE_ID.test(arg)) return null;
      return { action, credentialId: arg };
    }
    case "confirm": {
      if (parts.length !== 3 || arg === void 0 || !CONFIRMATION_ID.test(arg)) return null;
      return { action, confirmationId: arg };
    }
    case "urole": {
      if (parts.length !== 5) return null;
      const userId = numericArg(parts[2]);
      const fromRole = parts[3] ?? "";
      const toRole2 = parts[4] ?? "";
      if (userId === null || !ROLES.has(fromRole) || !ROLES.has(toRole2)) return null;
      return { action, userId, fromRole, toRole: toRole2 };
    }
    case "ustat": {
      if (parts.length !== 4) return null;
      const userId = numericArg(parts[2]);
      const nextStatus = parts[3] ?? "";
      if (userId === null || !STATUSES.has(nextStatus)) return null;
      return { action, userId, nextStatus };
    }
    case "addprov":
      return parts.length === 2 ? { action } : null;
    case "addcred": {
      if (parts.length !== 3 || arg === void 0 || !SAFE_ID.test(arg)) return null;
      return { action, providerId: arg };
    }
    case "editprov": {
      if (parts.length !== 4 || arg === void 0 || !SAFE_ID.test(arg)) return null;
      const field = parts[3] ?? "";
      if (!["baseUrl", "defaultModel", "weight", "timeoutMs", "maxCredentialAttempts"].includes(field)) return null;
      return { action, providerId: arg, field };
    }
    default:
      return null;
  }
}
__name(parseAdminCallback, "parseAdminCallback");
function clamp(text) {
  return text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\u2026` : text;
}
__name(clamp, "clamp");
function backButton() {
  return { text: "\u2190 Back", callbackData: "a:menu" };
}
__name(backButton, "backButton");
function renderMenu() {
  return {
    text: "HawkTalk Admin\n\nSelect a section:",
    keyboard: [
      [{ text: "\u{1F4CA} Dashboard", callbackData: "a:dashboard" }],
      [{ text: "\u{1F465} Users", callbackData: "a:users" }],
      [{ text: "\u{1F916} Providers", callbackData: "a:providers" }],
      [{ text: "\u{1F4C8} Quotas", callbackData: "a:policy:USER" }],
      [{ text: "\u{1F6E0} Tools", callbackData: "a:tools" }],
      [{ text: "\u{1F4CB} Audit Logs", callbackData: "a:audit" }],
      [{ text: "\u{1F4B0} Usage", callbackData: "a:usage" }],
      [{ text: "\u{1F6F0} Routing", callbackData: "a:routing" }]
    ]
  };
}
__name(renderMenu, "renderMenu");
function renderDashboard(metrics) {
  const roles = Object.entries(metrics.usersByRole).map(([role, count]) => `${role}: ${count}`).join(", ");
  const recent = metrics.recentAudit.length > 0 ? metrics.recentAudit.map((entry) => `${entry.success ? "\u2713" : "\u2717"} ${entry.action}`).join("\n") : "No admin activity yet.";
  return {
    text: clamp(`\u{1F4CA} Dashboard

Users: ${metrics.totalUsers} (${roles})
Providers: ${metrics.providers.enabled}/${metrics.providers.total} enabled
Credentials: ${metrics.credentialCount}

Recent admin activity:
${recent}`),
    keyboard: [[backButton()]]
  };
}
__name(renderDashboard, "renderDashboard");
function renderUserList(users, nextCursor) {
  const lines = users.map((user) => `#${user.id} tg:${user.telegram_user_id} ${user.role}${user.status !== "active" ? ` (${user.status})` : ""}`);
  const keyboard = users.slice(0, 10).map((user) => [{ text: `#${user.id} ${user.role}`, callbackData: `a:user:${user.id}` }]);
  if (nextCursor !== null) keyboard.push([{ text: "Next \u2192", callbackData: `a:users:${nextCursor}` }]);
  keyboard.push([backButton()]);
  return { text: clamp(`\u{1F465} Users

${lines.length > 0 ? lines.join("\n") : "No users."}`), keyboard };
}
__name(renderUserList, "renderUserList");
function renderUserDetail(user) {
  const keyboard = [];
  const roleRow = [];
  if (user.role !== "USER") roleRow.push({ text: "\u2192 USER", callbackData: `a:urole:${user.id}:${user.role}:USER` });
  if (user.role !== "VIP") roleRow.push({ text: "\u2192 VIP", callbackData: `a:urole:${user.id}:${user.role}:VIP` });
  if (user.role !== "ADMIN") roleRow.push({ text: "\u2192 ADMIN", callbackData: `a:urole:${user.id}:${user.role}:ADMIN` });
  if (roleRow.length > 0) keyboard.push(roleRow);
  keyboard.push([{ text: user.status === "active" ? "\u{1F6AB} Block" : "\u2705 Unblock", callbackData: `a:ustat:${user.id}:${user.status === "active" ? "blocked" : "active"}` }]);
  keyboard.push([{ text: "\u2190 Users", callbackData: "a:users" }]);
  return {
    text: clamp(`\u{1F464} User #${user.id}
Telegram: ${user.telegram_user_id}
Name: ${user.display_name ?? "\u2014"}
Username: ${user.username ?? "\u2014"}
Role: ${user.role}
Status: ${user.status}
Created: ${user.created_at}`),
    keyboard
  };
}
__name(renderUserDetail, "renderUserDetail");
function renderProviderList(providers) {
  const lines = providers.map((provider) => `${provider.enabled ? "\u{1F7E2}" : "\u{1F534}"} ${provider.id} (${provider.credentialCount} cred, ${provider.defaultModel})`);
  const keyboard = providers.slice(0, 10).map((provider) => [{ text: `${provider.id}`, callbackData: `a:provider:${provider.id}` }]);
  keyboard.push([{ text: "+ Add Provider", callbackData: "a:addprov" }]);
  keyboard.push([backButton()]);
  return {
    text: clamp(`\u{1F916} Providers

${lines.length > 0 ? lines.join("\n") : "No providers configured."}`),
    keyboard
  };
}
__name(renderProviderList, "renderProviderList");
function renderProviderDetail(provider, actorRole) {
  const keyboard = [];
  keyboard.push([{ text: provider.enabled ? "\u23F8 Disable" : "\u25B6 Enable", callbackData: `a:provtog:${provider.id}:${provider.enabled ? "off" : "on"}` }]);
  keyboard.push([
    { text: "Edit URL", callbackData: `a:editprov:${provider.id}:baseUrl` },
    { text: "Edit Model", callbackData: `a:editprov:${provider.id}:defaultModel` }
  ]);
  keyboard.push([
    { text: "Edit Weight", callbackData: `a:editprov:${provider.id}:weight` },
    { text: "Edit Timeout", callbackData: `a:editprov:${provider.id}:timeoutMs` }
  ]);
  for (const credential of provider.credentials) {
    const row = [{ text: `${credential.enabled ? "\u23F8" : "\u25B6"} ${credential.id}`, callbackData: `a:credtog:${credential.id}:${credential.enabled ? "off" : "on"}` }];
    if (actorRole === "OWNER") row.push({ text: "\u{1F5D1} Delete", callbackData: `a:credask:${credential.id}` });
    keyboard.push(row);
  }
  keyboard.push([{ text: "+ Add Credential", callbackData: `a:addcred:${provider.id}` }]);
  keyboard.push([{ text: "\u2190 Providers", callbackData: "a:providers" }]);
  const credentials = provider.credentials.map((credential) => `${credential.enabled ? "\u{1F7E2}" : "\u{1F534}"} ${credential.id} "${credential.label}" w${credential.weight}`).join("\n");
  return {
    text: clamp(`\u2699\uFE0F Provider ${provider.id}

URL: ${provider.baseUrl}
Model: ${provider.defaultModel}
Enabled: ${provider.enabled ? "yes" : "no"}
Weight: ${provider.weight}
Timeout: ${provider.timeoutMs} ms
Credential attempts: ${provider.maxCredentialAttempts}

Credentials:
${credentials || "None"}`),
    keyboard
  };
}
__name(renderProviderDetail, "renderProviderDetail");
function renderConfirmation(pending) {
  const what = pending.action === "credentials.delete" ? `permanently delete credential "${pending.targetId}"` : pending.action === "users.set_role" ? "change a privileged role" : "block a privileged user";
  return {
    text: clamp(`\u26A0\uFE0F Confirmation required

You are about to ${what}.
This cannot be undone.`),
    keyboard: [
      [{ text: "\u2705 Confirm", callbackData: `a:confirm:${pending.confirmationId}` }],
      [{ text: "\u2190 Back", callbackData: "a:menu" }]
    ]
  };
}
__name(renderConfirmation, "renderConfirmation");
function renderPolicy(policy) {
  return {
    text: clamp(`\u{1F4C8} Policy \u2014 ${policy.role}

Daily messages: ${policy.dailyMessages}
Per second: ${policy.perSecond}
Per hour: ${policy.perHour}
Bypass quota: ${policy.bypassQuota ? "yes" : "no"}
Bypass rate: ${policy.bypassRate ? "yes" : "no"}`),
    keyboard: [[backButton()]]
  };
}
__name(renderPolicy, "renderPolicy");
function renderTools(tools) {
  return {
    text: clamp(`\u{1F6E0} Tools

${tools.length > 0 ? tools.join("\n") : "No tools registered."}`),
    keyboard: [[backButton()]]
  };
}
__name(renderTools, "renderTools");
function renderUsage(summary) {
  const dollars = (summary.estimatedCostMicrodollars / 1e6).toFixed(4);
  return {
    text: clamp(`\u{1F4B0} Usage & Cost

Generations: ${summary.generations}
Input tokens: ${summary.inputTokens}
Output tokens: ${summary.outputTokens}
Estimated spend: $${dollars} (estimates only)`),
    keyboard: [[backButton()]]
  };
}
__name(renderUsage, "renderUsage");
function renderRouting(profiles) {
  const lines = profiles.map((entry) => `${entry.label} (${entry.profile}) \u2014 ${entry.description}`).join("\n");
  return {
    text: clamp(`\u{1F6F0} Model Routing

${lines}

Select profiles in conversation with /fast, /smart, /research (default when omitted).`),
    keyboard: [[backButton()]]
  };
}
__name(renderRouting, "renderRouting");
function renderAudit(records, nextCursor) {
  const lines = records.map((record) => `#${record.id} ${record.createdAt} ${record.actorRole} ${record.action}${record.targetId !== null ? ` \u2192 ${record.targetId}` : ""}${record.success ? "" : " [failed]"}`);
  const keyboard = [];
  if (nextCursor !== null) keyboard.push([{ text: "Next \u2192", callbackData: `a:audit:${nextCursor}` }]);
  keyboard.push([backButton()]);
  return {
    text: clamp(`\u{1F4CB} Audit Logs

${lines.length > 0 ? lines.join("\n") : "No audit records."}`),
    keyboard
  };
}
__name(renderAudit, "renderAudit");
function renderAddProviderInstructions() {
  return {
    text: clamp("Add Provider\n\nProviders are created via the secure provisioning CLI (never via chat):\n\nnode --experimental-strip-types scripts/provision.mjs provider <id> <base-url> <default-model> [weight] [timeout-ms] [max-attempts] --env production\n\nFields: id (lowercase [a-z0-9-]), base_url (https only), default_model. Optional: weight (1-10000, default 100), timeout_ms (1000-120000, default 30000), max_credential_attempts (1-10, default 3)."),
    keyboard: [[{ text: "\u2190 Providers", callbackData: "a:providers" }]]
  };
}
__name(renderAddProviderInstructions, "renderAddProviderInstructions");
function renderEditProviderField(providerId, field, currentValue) {
  return {
    text: clamp(`Edit ${field}

Provider: ${providerId}
Field: ${field}
Current value: ${currentValue}

Updates are applied via the secure provisioning CLI so the same validation applies:

Re-create with node --experimental-strip-types scripts/provision.mjs provider ... (safe no-op if unchanged) or update via wrangler d1 execute using the CLI-validated value. Do not send configuration values through Telegram.`),
    keyboard: [
      [{ text: "\u2190 Provider", callbackData: `a:provider:${providerId}` }],
      [{ text: "\u2190 Providers", callbackData: "a:providers" }]
    ]
  };
}
__name(renderEditProviderField, "renderEditProviderField");
function renderAddCredentialInstructions(providerId) {
  return {
    text: clamp(`Add Credential

Provider: ${providerId}

API keys MUST NOT be sent through Telegram (chat history persists server-side).

Provision securely with the committed CLI \u2014 the key is read from a hidden stdin prompt and sealed with AES-GCM before storage:

node --experimental-strip-types scripts/provision.mjs credential ${providerId} "<label>" --env production

The plaintext key exists only transiently during encryption and never appears in logs, audit records, or admin listings.`),
    keyboard: [
      [{ text: "\u2190 Provider", callbackData: `a:provider:${providerId}` }],
      [{ text: "\u2190 Providers", callbackData: "a:providers" }]
    ]
  };
}
__name(renderAddCredentialInstructions, "renderAddCredentialInstructions");

// src/telegram/user-commands.ts
var MODE_COMMANDS = {
  "/fast": "FAST",
  "/smart": "COMPLEX",
  "/research": "RESEARCH"
};
var MAX_COMMAND_QUERY_CHARS = 4e3;
function parseUserCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  for (const command of Object.keys(MODE_COMMANDS)) {
    if (trimmed === command) return { profile: MODE_COMMANDS[command], query: "" };
    if (trimmed.startsWith(`${command} `)) {
      const query = trimmed.slice(command.length + 1).trim().slice(0, MAX_COMMAND_QUERY_CHARS);
      return { profile: MODE_COMMANDS[command], query };
    }
  }
  return null;
}
__name(parseUserCommand, "parseUserCommand");
var MODE_COMMAND_USAGE_HINT = "Usage: /fast <question>, /smart <question>, or /research <question>. Send the command with your question to use that routing profile.";

// src/telegram/admin-handler.ts
var ADMIN_ACCESS_DENIED_TEXT = "You are not authorized to use admin commands.";
var GENERIC_ADMIN_FAILURE_TEXT = "The admin service is temporarily unavailable. Try again later.";
function errorOutcome(error) {
  if (error instanceof AdminError) return { kind: "answer", text: adminErrorText(error.kind) };
  return { kind: "answer", text: GENERIC_ADMIN_FAILURE_TEXT };
}
__name(errorOutcome, "errorOutcome");
async function handleAdminCommand(db, adminService, actorTelegramId) {
  const actorUserId = await findInternalUserIdByTelegramId(db, actorTelegramId).catch(() => null);
  if (actorUserId === null) return { kind: "answer", text: ADMIN_ACCESS_DENIED_TEXT };
  try {
    await adminService.checkAccess(actorUserId);
  } catch (error) {
    return errorOutcome(error);
  }
  return { kind: "view", view: renderMenu() };
}
__name(handleAdminCommand, "handleAdminCommand");
async function executeAdminCallback(adminService, actorUserId, actorRole, cb) {
  switch (cb.action) {
    case "menu":
      return { kind: "view", view: renderMenu() };
    case "dashboard":
      return { kind: "view", view: renderDashboard(await adminService.getDashboard(actorUserId)) };
    case "users": {
      const page = await adminService.listUsers(actorUserId, cb.cursor);
      return { kind: "view", view: renderUserList(page.users, page.nextCursor) };
    }
    case "user":
      return { kind: "view", view: renderUserDetail(await adminService.inspectUser(actorUserId, cb.userId)) };
    case "providers":
      return { kind: "view", view: renderProviderList(await adminService.listProviders(actorUserId)) };
    case "provider":
      return { kind: "view", view: renderProviderDetail(await adminService.inspectProvider(actorUserId, cb.providerId), actorRole) };
    case "provtog": {
      await adminService.setProviderEnabled(actorUserId, cb.providerId, cb.enabled);
      return { kind: "view", view: renderProviderDetail(await adminService.inspectProvider(actorUserId, cb.providerId), actorRole) };
    }
    case "credtog": {
      await adminService.setCredentialEnabled(actorUserId, cb.credentialId, cb.enabled);
      const meta = await adminService.inspectCredential(actorUserId, cb.credentialId);
      return { kind: "view", view: renderProviderDetail(await adminService.inspectProvider(actorUserId, meta.providerId), actorRole) };
    }
    case "credask": {
      const pending = await adminService.requestDestructiveConfirmation(actorUserId, { action: "credentials.delete", credentialId: cb.credentialId });
      return { kind: "view", view: renderConfirmation(pending) };
    }
    case "confirm": {
      const outcome = await adminService.executeConfirmed(actorUserId, cb.confirmationId);
      if (outcome.targetType === "user") {
        return { kind: "view", view: renderUserDetail(await adminService.inspectUser(actorUserId, Number(outcome.targetId))) };
      }
      return { kind: "answer", text: "\u2705 Done. The credential was deleted." };
    }
    case "urole": {
      const target = await adminService.inspectUser(actorUserId, cb.userId);
      if (target.role !== cb.fromRole) throw new AdminError("conflict", "User changed; reload.");
      const privileged = target.role === "ADMIN" || target.role === "OWNER" || target.role === "BLOCKED" || cb.toRole === "ADMIN" || cb.toRole === "OWNER";
      if (privileged) {
        const pending = await adminService.requestDestructiveConfirmation(actorUserId, {
          action: "users.set_role",
          userId: cb.userId,
          expectedRole: cb.fromRole,
          nextRole: cb.toRole
        });
        return { kind: "view", view: renderConfirmation(pending) };
      }
      await adminService.setUserRole(actorUserId, cb.userId, cb.fromRole, cb.toRole);
      return { kind: "view", view: renderUserDetail(await adminService.inspectUser(actorUserId, cb.userId)) };
    }
    case "ustat": {
      const target = await adminService.inspectUser(actorUserId, cb.userId);
      const privilegedBlock = cb.nextStatus === "blocked" && (target.role === "ADMIN" || target.role === "OWNER" || target.role === "BLOCKED");
      if (privilegedBlock) {
        const pending = await adminService.requestDestructiveConfirmation(actorUserId, { action: "users.set_status", userId: cb.userId, nextStatus: "blocked" });
        return { kind: "view", view: renderConfirmation(pending) };
      }
      await adminService.setUserStatus(actorUserId, cb.userId, cb.nextStatus);
      return { kind: "view", view: renderUserDetail(await adminService.inspectUser(actorUserId, cb.userId)) };
    }
    case "policy": {
      const policy = (await adminService.listPolicies(actorUserId)).find((p) => p.role === cb.role);
      if (policy === void 0) throw new AdminError("not_found", "Policy not found");
      return { kind: "view", view: renderPolicy(policy) };
    }
    case "audit": {
      const page = await adminService.listAudit(actorUserId, cb.cursor);
      return { kind: "view", view: renderAudit(page.records, page.nextCursor) };
    }
    case "tools":
      return { kind: "view", view: renderTools(await adminService.listTools(actorUserId, [])) };
    case "usage":
      return { kind: "view", view: renderUsage(await adminService.getUsageSummary(actorUserId)) };
    case "routing":
      return { kind: "view", view: renderRouting(await adminService.getRoutingProfiles(actorUserId)) };
    case "credentials":
      return { kind: "answer", text: adminErrorText("validation_failed") };
    case "addprov":
      return { kind: "view", view: renderAddProviderInstructions() };
    case "editprov": {
      const detail = await adminService.inspectProvider(actorUserId, cb.providerId);
      const currentValue = cb.field === "baseUrl" ? detail.baseUrl : cb.field === "defaultModel" ? detail.defaultModel : cb.field === "weight" ? String(detail.weight) : cb.field === "timeoutMs" ? String(detail.timeoutMs) : String(detail.maxCredentialAttempts);
      return { kind: "view", view: renderEditProviderField(cb.providerId, cb.field, currentValue) };
    }
    case "addcred":
      return { kind: "view", view: renderAddCredentialInstructions(cb.providerId) };
    default: {
      const exhaustive = cb;
      void exhaustive;
      return { kind: "answer", text: adminErrorText("validation_failed") };
    }
  }
}
__name(executeAdminCallback, "executeAdminCallback");
async function handleAdminCallback(db, adminService, actorTelegramId, data) {
  const parsed = parseAdminCallback(data);
  if (parsed === null) {
    return { kind: "answer", text: adminErrorText("validation_failed") };
  }
  const actorUserId = await findInternalUserIdByTelegramId(db, actorTelegramId).catch(() => null);
  if (actorUserId === null) return { kind: "answer", text: ADMIN_ACCESS_DENIED_TEXT };
  try {
    const actor = await adminService.checkAccess(actorUserId);
    return await executeAdminCallback(adminService, actor.userId, actor.role, parsed);
  } catch (error) {
    return errorOutcome(error);
  }
}
__name(handleAdminCallback, "handleAdminCallback");

// src/telegram/memory-commands.ts
var MEMORY_COMMANDS = ["/remember", "/memories", "/forget"];
function parseMemoryCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  for (const cmd of MEMORY_COMMANDS) {
    if (trimmed === cmd) return { command: cmd, arg: "" };
    if (trimmed.startsWith(`${cmd} `)) {
      return { command: cmd, arg: trimmed.slice(cmd.length + 1).trim() };
    }
  }
  return null;
}
__name(parseMemoryCommand, "parseMemoryCommand");
async function handleMemoryCommand(parsed, userId, service) {
  switch (parsed.command) {
    case "/remember": {
      if (parsed.arg.length === 0) {
        return { text: "Usage: /remember <text to remember>" };
      }
      try {
        await service.store(userId, parsed.arg);
        return { text: "Saved." };
      } catch (err) {
        if (err && typeof err === "object" && "kind" in err) {
          const kind = err.kind;
          if (kind === "capacity") return { text: "Memory limit reached. Use /forget to remove old memories first." };
          if (kind === "invalid") return { text: "Memory content must be between 2 and 2000 characters." };
        }
        return { text: "Could not save memory. Try again later." };
      }
    }
    case "/memories": {
      try {
        const list = await service.list(userId, 20);
        if (list.length === 0) return { text: "No memories stored." };
        const lines = list.map((m, i) => `${i + 1}. ${m.content.slice(0, 100)}${m.content.length > 100 ? "..." : ""}`);
        const body = lines.join("\n");
        return { text: body.length > 4e3 ? body.slice(0, 3999) + "\u2026" : body };
      } catch {
        return { text: "Could not retrieve memories. Try again later." };
      }
    }
    case "/forget": {
      if (parsed.arg.length === 0) {
        try {
          const count = await service.clear(userId);
          return { text: count === 0 ? "No memories to clear." : `Cleared ${count} memories.` };
        } catch {
          return { text: "Could not clear memories. Try again later." };
        }
      }
      return { text: "Usage: /forget (clears all memories). To store: /remember <text>" };
    }
    default:
      return { text: "Unknown memory command." };
  }
}
__name(handleMemoryCommand, "handleMemoryCommand");

// src/db/providers.ts
async function listEnabledProviders(db) {
  const result = await db.prepare("SELECT * FROM providers WHERE enabled != 0 ORDER BY weight DESC, id ASC").all();
  return result.results;
}
__name(listEnabledProviders, "listEnabledProviders");
async function listCredentialsForProvider(db, providerId) {
  const result = await db.prepare("SELECT * FROM provider_credentials WHERE provider_id = ? ORDER BY weight DESC, id ASC").bind(providerId).all();
  return result.results;
}
__name(listCredentialsForProvider, "listCredentialsForProvider");

// src/ai/adapter.ts
var OPENAI_CHAT_COMPLETIONS_PATH = "/chat/completions";
var DEFAULT_ADAPTER_TIMEOUT_MS = 3e4;
var MAX_RESPONSE_BYTES = 512 * 1024;
var MAX_DETAIL_CHARS = 200;
function sanitizeDetail(text) {
  return text.replace(/[^\x20-\x7E]/g, "?").slice(0, MAX_DETAIL_CHARS);
}
__name(sanitizeDetail, "sanitizeDetail");
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord2, "isRecord");
var OpenAICompatibleAdapter = class {
  static {
    __name(this, "OpenAICompatibleAdapter");
  }
  id;
  baseUrl;
  apiKey;
  fetchImpl;
  timeoutMs;
  constructor(options) {
    if (typeof options.id !== "string" || options.id.length === 0) throw new Error("Adapter id is required");
    if (typeof options.baseUrl !== "string" || options.baseUrl.length === 0) throw new Error("Adapter base URL is required");
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) throw new Error("Adapter API key is required");
    const timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Adapter timeout must be a positive integer");
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.timeoutMs = timeoutMs;
  }
  async generate(input) {
    if (input.signal?.aborted === true) throw new ProviderError("timeout");
    const body = JSON.stringify({
      model: input.model,
      messages: [
        ...input.systemPrompt.length > 0 ? [{ role: "system", content: input.systemPrompt }] : [],
        ...input.messages.map((message2) => ({ role: message2.role, content: message2.content }))
      ],
      max_tokens: input.maxOutputTokens,
      ...input.temperature !== void 0 ? { temperature: input.temperature } : {}
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onCallerAbort = /* @__PURE__ */ __name(() => controller.abort(), "onCallerAbort");
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${OPENAI_CHAT_COMPLETIONS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body,
        signal: controller.signal
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") {
        throw new ProviderError("timeout");
      }
      throw new ProviderError("upstream", void 0, {
        phase: "network",
        detail: sanitizeDetail(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onCallerAbort);
    }
    if (!response.ok) {
      const contentType2 = response.headers.get("content-type") ?? void 0;
      let detail;
      try {
        detail = sanitizeDetail(await response.text());
      } catch {
        detail = void 0;
      }
      throw new ProviderError("upstream", response.status, { phase: "http", ...detail !== void 0 ? { detail } : {}, ...contentType2 !== void 0 ? { contentType: contentType2 } : {} });
    }
    let payload;
    let rawText;
    const contentType = response.headers.get("content-type") ?? void 0;
    try {
      rawText = await response.text();
      if (rawText.length === 0 || rawText.length > MAX_RESPONSE_BYTES) {
        throw new ProviderError("malformed", void 0, {
          phase: "parse",
          detail: rawText.length === 0 ? "empty body" : "body exceeds size limit",
          ...contentType !== void 0 ? { contentType } : {}
        });
      }
      payload = JSON.parse(rawText);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("malformed", void 0, {
        phase: "parse",
        ...rawText !== void 0 ? { detail: sanitizeDetail(rawText) } : {},
        ...contentType !== void 0 ? { contentType } : {}
      });
    }
    if (!isRecord2(payload)) throw new ProviderError("malformed", void 0, { phase: "schema", detail: "payload not an object" });
    const choices = payload["choices"];
    if (!Array.isArray(choices) || choices.length === 0) throw new ProviderError("malformed", void 0, { phase: "schema", detail: "missing or empty choices" });
    const first = choices[0];
    if (!isRecord2(first)) throw new ProviderError("malformed", void 0, { phase: "schema", detail: "first choice not an object" });
    const message = first["message"];
    if (!isRecord2(message) || typeof message["content"] !== "string" || message["content"].length === 0)
      throw new ProviderError("malformed", void 0, { phase: "schema", detail: "missing or empty message content" });
    const result = {
      text: message["content"],
      model: typeof payload["model"] === "string" && payload["model"].length > 0 ? payload["model"] : input.model
    };
    const usage = payload["usage"];
    if (isRecord2(usage)) {
      const inputTokens = usage["prompt_tokens"];
      const outputTokens = usage["completion_tokens"];
      if (inputTokens !== void 0 && (!Number.isInteger(inputTokens) || inputTokens < 0) || outputTokens !== void 0 && (!Number.isInteger(outputTokens) || outputTokens < 0)) {
        throw new ProviderError("malformed", void 0, { phase: "schema", detail: "invalid usage token fields" });
      }
      if (inputTokens !== void 0 || outputTokens !== void 0) {
        result.usage = {};
        if (inputTokens !== void 0) result.usage.inputTokens = inputTokens;
        if (outputTokens !== void 0) result.usage.outputTokens = outputTokens;
      }
    }
    return result;
  }
};

// src/ai/crypto.ts
var VERSION = "v1";
var SALT_BYTES = 16;
var IV_BYTES = 12;
var PBKDF2_ITERATIONS = 1e5;
function bytesToB64Url(bytes) {
  let binary = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(bytesToB64Url, "bytesToB64Url");
function b64UrlToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
__name(b64UrlToBytes, "b64UrlToBytes");
function randomBytes(length) {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}
__name(randomBytes, "randomBytes");
async function deriveKey(masterSecret, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(masterSecret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
__name(deriveKey, "deriveKey");
async function sealCredential(plaintext, masterSecret) {
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new Error("Cannot seal an empty credential");
  if (typeof masterSecret !== "string" || masterSecret.length === 0) throw new Error("Credential master secret is not configured");
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(masterSecret, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext))
  );
  return `${VERSION}.${bytesToB64Url(salt)}.${bytesToB64Url(iv)}.${bytesToB64Url(ciphertext)}`;
}
__name(sealCredential, "sealCredential");
async function unsealCredential(sealed, masterSecret) {
  if (typeof masterSecret !== "string" || masterSecret.length === 0) throw new Error("Credential master secret is not configured");
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Credential envelope is invalid");
  const [, saltB64, ivB64, ctB64] = parts;
  let salt;
  let iv;
  let ciphertext;
  try {
    salt = b64UrlToBytes(saltB64);
    iv = b64UrlToBytes(ivB64);
    ciphertext = b64UrlToBytes(ctB64);
  } catch {
    throw new Error("Credential envelope is invalid");
  }
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ciphertext.length === 0) {
    throw new Error("Credential envelope is invalid");
  }
  try {
    const key = await deriveKey(masterSecret, salt);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Credential decryption failed");
  }
}
__name(unsealCredential, "unsealCredential");

// src/ai/credentials.ts
var D1CredentialStore = class {
  static {
    __name(this, "D1CredentialStore");
  }
  db;
  constructor(db) {
    this.db = db;
  }
  async listCredentials(providerId) {
    const rows = await listCredentialsForProvider(this.db, providerId);
    return rows.map((row) => ({
      id: row.id,
      providerId: row.provider_id,
      label: row.label,
      enabled: row.enabled !== 0,
      weight: row.weight,
      ciphertext: row.secret_ciphertext
    }));
  }
};
async function resolveCredentialPlaintext(ciphertext, masterSecret) {
  return unsealCredential(ciphertext, masterSecret);
}
__name(resolveCredentialPlaintext, "resolveCredentialPlaintext");

// src/ai/router.ts
function endpointMeta(baseUrl) {
  try {
    const parsed = new URL(`${baseUrl.replace(/\/+$/, "")}${OPENAI_CHAT_COMPLETIONS_PATH}`);
    return { endpoint_host: parsed.hostname.slice(0, 128), endpoint_path: parsed.pathname.slice(0, 128) };
  } catch {
    return {};
  }
}
__name(endpointMeta, "endpointMeta");
function errorMeta(error) {
  const meta = { code: error.code };
  if (error.phase !== void 0) meta["failure_phase"] = error.phase;
  if (error.httpStatus !== void 0) meta["http_status"] = error.httpStatus;
  if (error.contentType !== void 0) meta["content_type"] = String(error.contentType).slice(0, 64);
  if (error.detail !== void 0) meta["detail"] = String(error.detail).slice(0, 200);
  return meta;
}
__name(errorMeta, "errorMeta");
var DEFAULT_RATE_LIMIT_COOLDOWN_MS = 6e4;
var DEFAULT_SERVER_ERROR_COOLDOWN_MS = 3e4;
var DEFAULT_INVALID_CREDENTIAL_COOLDOWN_MS = 36e5;
var DEFAULT_MAX_ROUTER_ATTEMPTS = 8;
var DEFAULT_ADAPTER_TIMEOUT_FALLBACK_MS = 3e4;
var DEFAULT_MAX_CREDENTIAL_ATTEMPTS = 3;
var InMemoryRouterHealth = class {
  static {
    __name(this, "InMemoryRouterHealth");
  }
  until = /* @__PURE__ */ new Map();
  nowMs;
  constructor(nowMs = () => Date.now()) {
    this.nowMs = nowMs;
  }
  cooledUntil(credentialId) {
    const until = this.until.get(credentialId);
    if (until === void 0) return void 0;
    if (until <= this.nowMs()) {
      this.until.delete(credentialId);
      return void 0;
    }
    return until;
  }
  cooldown(credentialId, untilMs) {
    const current = this.until.get(credentialId);
    if (current === void 0 || untilMs > current) this.until.set(credentialId, untilMs);
  }
};
function orderCredentials(credentials, health, nowMs) {
  return credentials.filter((credential) => credential.enabled).filter((credential) => {
    const until = health.cooledUntil(credential.id);
    return until === void 0 || until <= nowMs;
  }).sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
__name(orderCredentials, "orderCredentials");
function isValidProviderId(id) {
  return typeof id === "string" && /^[a-z0-9-]{1,64}$/.test(id);
}
__name(isValidProviderId, "isValidProviderId");
function positiveIntOr(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
__name(positiveIntOr, "positiveIntOr");
function providerRowToEntry(row) {
  if (!isValidProviderId(row.id)) return null;
  if (typeof row.base_url !== "string" || row.base_url.length === 0) return null;
  if (typeof row.default_model !== "string" || row.default_model.length === 0) return null;
  return {
    id: row.id,
    baseUrl: row.base_url,
    weight: positiveIntOr(row.weight, 100),
    defaultModel: row.default_model,
    timeoutMs: positiveIntOr(row.timeout_ms, DEFAULT_ADAPTER_TIMEOUT_FALLBACK_MS),
    maxCredentialAttempts: positiveIntOr(row.max_credential_attempts, DEFAULT_MAX_CREDENTIAL_ATTEMPTS)
  };
}
__name(providerRowToEntry, "providerRowToEntry");
var D1ProviderDirectory = class {
  static {
    __name(this, "D1ProviderDirectory");
  }
  db;
  constructor(db) {
    this.db = db;
  }
  async listEnabledProviders() {
    const rows = await listEnabledProviders(this.db);
    const entries = [];
    for (const row of rows) {
      const entry = providerRowToEntry(row);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }
};
var AIRouter = class {
  static {
    __name(this, "AIRouter");
  }
  id = "router";
  directory;
  credentialStore;
  health;
  masterSecret;
  fetchImpl;
  nowMs;
  cooldowns;
  maxAttempts;
  constructor(options) {
    if (typeof options.masterSecret !== "string" || options.masterSecret.length === 0) {
      throw new Error("Credential master secret is not configured");
    }
    this.directory = options.directory;
    this.credentialStore = options.credentialStore;
    this.health = options.health;
    this.masterSecret = options.masterSecret;
    this.fetchImpl = options.fetchImpl;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.cooldowns = {
      rateLimitedMs: positiveIntOr(options.cooldowns?.rateLimitedMs, DEFAULT_RATE_LIMIT_COOLDOWN_MS),
      serverErrorMs: positiveIntOr(options.cooldowns?.serverErrorMs, DEFAULT_SERVER_ERROR_COOLDOWN_MS),
      invalidCredentialMs: positiveIntOr(options.cooldowns?.invalidCredentialMs, DEFAULT_INVALID_CREDENTIAL_COOLDOWN_MS)
    };
    this.maxAttempts = positiveIntOr(options.maxAttempts, DEFAULT_MAX_ROUTER_ATTEMPTS);
  }
  resolveTarget(model, providers) {
    const separator = model.indexOf(":");
    if (separator > 0) {
      const providerId = model.slice(0, separator);
      const remainder = model.slice(separator + 1);
      const provider = providers.find((entry) => entry.id === providerId);
      if (!provider) return null;
      if (remainder.length > 0) {
        return { provider, vendorModel: remainder, providers: [provider] };
      }
      return { provider, vendorModel: provider.defaultModel, providers, perProviderDefault: true };
    }
    if (providers.length === 0) return null;
    const first = providers[0];
    return { provider: first, vendorModel: model, providers };
  }
  async generate(input) {
    if (typeof input.model !== "string" || input.model.length === 0 || input.model.startsWith(":")) {
      throw new ProviderError("malformed");
    }
    if (input.signal?.aborted === true) throw new ProviderError("timeout");
    const providers = await this.directory.listEnabledProviders().catch(() => []);
    const target = this.resolveTarget(input.model, providers);
    if (target === null) {
      console.error(JSON.stringify({ event: "router_no_target", request_id: input.requestId.slice(0, 128), model: input.model.slice(0, 128), enabled_providers: providers.length }));
      throw new ProviderError("unavailable");
    }
    console.error(JSON.stringify({ event: "router_target", request_id: input.requestId.slice(0, 128), provider_id: target.provider.id, model: target.vendorModel.slice(0, 128), candidates: target.providers.length }));
    let attempts = 0;
    let lastError = new ProviderError("unavailable");
    for (const provider of target.providers) {
      const vendorModel = target.perProviderDefault === true ? provider.defaultModel : target.vendorModel;
      const credentials = await this.credentialStore.listCredentials(provider.id).catch(() => []);
      const ordered = orderCredentials(credentials, this.health, this.nowMs());
      const budget = Math.min(provider.maxCredentialAttempts, ordered.length);
      console.error(JSON.stringify({ event: "router_credentials", request_id: input.requestId.slice(0, 128), provider_id: provider.id, model: vendorModel.slice(0, 128), credentials: ordered.length, budget }));
      for (let i = 0; i < budget; i += 1) {
        if (attempts >= this.maxAttempts) break;
        const credential = ordered[i];
        attempts += 1;
        let apiKey;
        try {
          apiKey = await resolveCredentialPlaintext(credential.ciphertext, this.masterSecret);
        } catch {
          console.error(JSON.stringify({ event: "credential_decrypt_failed", request_id: input.requestId.slice(0, 128), provider_id: provider.id, credential_id: credential.id }));
          this.health.cooldown(credential.id, this.nowMs() + this.cooldowns.invalidCredentialMs);
          lastError = new ProviderError("unavailable");
          continue;
        }
        const adapterOptions = {
          id: provider.id,
          baseUrl: provider.baseUrl,
          apiKey,
          timeoutMs: provider.timeoutMs
        };
        if (this.fetchImpl !== void 0) {
          adapterOptions.fetchImpl = this.fetchImpl;
        }
        const adapter = new OpenAICompatibleAdapter(adapterOptions);
        try {
          return await adapter.generate({ ...input, model: vendorModel });
        } catch (error) {
          if (!(error instanceof ProviderError)) {
            console.error(JSON.stringify({ event: "provider_attempt_failed", request_id: input.requestId.slice(0, 128), provider_id: provider.id, credential_id: credential.id, model: vendorModel.slice(0, 128), ...endpointMeta(provider.baseUrl), code: "non_provider_error", name: error instanceof Error ? error.name : typeof error }));
            lastError = new ProviderError("upstream");
            continue;
          }
          lastError = error;
          console.error(JSON.stringify({ event: "provider_attempt_failed", request_id: input.requestId.slice(0, 128), provider_id: provider.id, credential_id: credential.id, model: vendorModel.slice(0, 128), ...endpointMeta(provider.baseUrl), ...errorMeta(error) }));
          const now = this.nowMs();
          if (error.code === "malformed") throw error;
          if (error.code === "timeout") {
            if (input.signal?.aborted) throw error;
            this.health.cooldown(credential.id, now + this.cooldowns.serverErrorMs);
            continue;
          }
          const status = error.httpStatus;
          if (status === 429) {
            this.health.cooldown(credential.id, now + this.cooldowns.rateLimitedMs);
            continue;
          }
          if (status === 401 || status === 403) {
            this.health.cooldown(credential.id, now + this.cooldowns.invalidCredentialMs);
            continue;
          }
          if (status !== void 0 && status >= 500) {
            this.health.cooldown(credential.id, now + this.cooldowns.serverErrorMs);
            continue;
          }
          if (status === void 0) continue;
          throw error;
        }
      }
      if (attempts >= this.maxAttempts) break;
    }
    console.error(JSON.stringify({ event: "router_exhausted", request_id: input.requestId.slice(0, 128), ...errorMeta(lastError) }));
    throw lastError;
  }
};

// src/db/usage.ts
var MAX_USAGE_EVENT_ID_CHARS = 64;
function validateUsageEventId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_USAGE_EVENT_ID_CHARS) {
    throw new Error("Invalid usage event id");
  }
  return value;
}
__name(validateUsageEventId, "validateUsageEventId");
async function recordUsageEvent(db, input) {
  const id = validateUsageEventId(input.id);
  const result = await db.prepare(
    `INSERT OR IGNORE INTO usage_events (id, user_id, provider_id, vendor_model, request_id, input_tokens, output_tokens, estimated_cost_microdollars, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?,
         COALESCE((
           SELECT CAST((? * p.input_microdollars_per_mtok + ? * p.output_microdollars_per_mtok) / 1000000 AS INTEGER)
           FROM provider_prices p WHERE p.provider_id = ? AND p.vendor_model = ?
         ), 0), ?`
  ).bind(
    id,
    input.userId,
    input.providerId,
    input.vendorModel,
    input.requestId,
    input.inputTokens,
    input.outputTokens,
    input.inputTokens,
    input.outputTokens,
    input.providerId,
    input.vendorModel,
    input.createdAt
  ).run();
  return (result.meta.changes ?? 0) > 0;
}
__name(recordUsageEvent, "recordUsageEvent");
var EMPTY_SUMMARY = { generations: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicrodollars: 0 };
async function summarizeAllUsage(db) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS generations, COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(estimated_cost_microdollars), 0) AS cost
       FROM usage_events`
  ).first();
  if (row === null) return { ...EMPTY_SUMMARY };
  return {
    generations: Number(row["generations"]),
    inputTokens: Number(row["input_tokens"]),
    outputTokens: Number(row["output_tokens"]),
    estimatedCostMicrodollars: Number(row["cost"])
  };
}
__name(summarizeAllUsage, "summarizeAllUsage");
async function setProviderPrice(db, providerId, vendorModel, inputPerMtok, outputPerMtok, updatedAt) {
  await db.prepare(
    `INSERT INTO provider_prices (provider_id, vendor_model, input_microdollars_per_mtok, output_microdollars_per_mtok, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provider_id, vendor_model) DO UPDATE SET
         input_microdollars_per_mtok = excluded.input_microdollars_per_mtok,
         output_microdollars_per_mtok = excluded.output_microdollars_per_mtok,
         updated_at = excluded.updated_at`
  ).bind(providerId, vendorModel, inputPerMtok, outputPerMtok, updatedAt).run();
}
__name(setProviderPrice, "setProviderPrice");

// src/tools/ssrf.ts
function isBlockedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  if (parsed.protocol !== "https:") return true;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "" || hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "metadata.google.internal" || hostname.startsWith("169.254.")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return isBlockedIPv4(hostname);
  }
  const ipv6 = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname.includes(":") ? hostname : null;
  if (ipv6 !== null) {
    return isBlockedIPv6(ipv6);
  }
  return false;
}
__name(isBlockedUrl, "isBlockedUrl");
function isBlockedIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const a = parts[0];
  const b = parts[1];
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a >= 224) return true;
  return false;
}
__name(isBlockedIPv4, "isBlockedIPv4");
function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1" || lower === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
  if (lower.startsWith("fe80") || lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("ff")) return true;
  const ipv4Match = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match?.[1]) return isBlockedIPv4(ipv4Match[1]);
  return false;
}
__name(isBlockedIPv6, "isBlockedIPv6");

// src/tools/web-fetch.ts
var MAX_FETCH_CHARS = 5e4;
var ALLOWED_CONTENT_PREFIXES = ["text/html", "text/plain", "application/json", "text/xml", "application/xml"];
var MAX_REDIRECTS = 5;
function createWebFetchTool(provider) {
  return {
    name: "web_fetch",
    description: "Fetch and extract text content from a URL. HTTPS only. Returns bounded plain text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The HTTPS URL to fetch" }
      },
      required: ["url"]
    },
    async execute(input, signal) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { kind: "validation_error", content: "Input must be an object with a url field" };
      }
      const obj = input;
      const url = obj["url"];
      if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
        return { kind: "validation_error", content: "URL must be a non-empty string under 2048 characters" };
      }
      if (isBlockedUrl(url)) {
        return { kind: "blocked", content: "URL is not allowed (must be HTTPS, no internal/private addresses)" };
      }
      try {
        const result = await fetchWithRedirectGuard(provider, url, signal);
        if (result === null) {
          return { kind: "blocked", content: "Redirect target was blocked or too many redirects" };
        }
        const contentType = result.contentType.toLowerCase();
        if (!ALLOWED_CONTENT_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
          return { kind: "validation_error", content: `Unsupported content type: ${contentType}` };
        }
        const extracted = extractText(result.body, contentType);
        const bounded2 = extracted.slice(0, Math.min(MAX_FETCH_CHARS, MAX_TOOL_RESULT_CHARS));
        return { kind: "success", content: bounded2 };
      } catch {
        return { kind: "upstream_error", content: "Fetch failed" };
      }
    }
  };
}
__name(createWebFetchTool, "createWebFetchTool");
async function fetchWithRedirectGuard(provider, url, signal) {
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
__name(fetchWithRedirectGuard, "fetchWithRedirectGuard");
function extractLocationFromBody() {
  return null;
}
__name(extractLocationFromBody, "extractLocationFromBody");
function extractText(body, contentType) {
  if (contentType.startsWith("text/html") || contentType.startsWith("text/xml") || contentType.startsWith("application/xml")) {
    return stripMarkup(body);
  }
  if (contentType.startsWith("application/json")) {
    return body.replace(/\s+/g, " ").trim();
  }
  return body.replace(/\s+/g, " ").trim();
}
__name(extractText, "extractText");
function stripMarkup(html) {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}
__name(stripMarkup, "stripMarkup");

// src/tools/web-search.ts
function createWebSearchTool(provider) {
  return {
    name: "web_search",
    description: "Search the web for current information. Returns titles, URLs, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "number", description: "Max results (1-10, default 5)" }
      },
      required: ["query"]
    },
    async execute(input, signal) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { kind: "validation_error", content: "Input must be an object with a query field" };
      }
      const obj = input;
      const query = obj["query"];
      if (typeof query !== "string" || query.trim().length === 0 || query.length > 500) {
        return { kind: "validation_error", content: "Query must be a non-empty string under 500 characters" };
      }
      let limit = 5;
      if (obj["limit"] !== void 0) {
        if (typeof obj["limit"] !== "number" || !Number.isInteger(obj["limit"]) || obj["limit"] < 1 || obj["limit"] > 10) {
          return { kind: "validation_error", content: "Limit must be an integer between 1 and 10" };
        }
        limit = obj["limit"];
      }
      try {
        const results = await provider.search(query.trim(), limit, signal);
        const formatted = results.map((r) => ({
          title: r.title.slice(0, 200),
          url: r.url.slice(0, 500),
          snippet: r.snippet.slice(0, 500)
        }));
        const content = JSON.stringify(formatted);
        if (content.length > MAX_TOOL_RESULT_CHARS) {
          return { kind: "success", content: content.slice(0, MAX_TOOL_RESULT_CHARS) };
        }
        return { kind: "success", content };
      } catch {
        return { kind: "upstream_error", content: "Search failed" };
      }
    }
  };
}
__name(createWebSearchTool, "createWebSearchTool");

// src/tools/research.ts
async function unavailableSearch() {
  throw new Error("search_unconfigured");
}
__name(unavailableSearch, "unavailableSearch");
function buildResearchTools(fetchImpl) {
  const resolvedFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const fetchTool = createWebFetchTool({
    fetch: /* @__PURE__ */ __name(async (url, signal) => {
      const init = signal === void 0 ? {} : { signal };
      const response = await resolvedFetch(url, init);
      const contentType = response.headers.get("content-type") ?? "text/plain";
      const body = await response.text();
      return { status: response.status, contentType, body };
    }, "fetch")
  });
  const searchTool = createWebSearchTool({ search: unavailableSearch });
  const tools = /* @__PURE__ */ new Map([
    ["web_fetch", fetchTool],
    ["web_search", searchTool]
  ]);
  return {
    names: [...RESEARCH_TOOL_ALLOWLIST],
    executor: /* @__PURE__ */ __name(async (name, input) => {
      const tool = RESEARCH_TOOL_ALLOWLIST.has(name) ? tools.get(name) : void 0;
      if (tool === void 0) return { kind: "validation_error", content: `Unknown tool: ${name}` };
      const result = await tool.execute(input);
      return { kind: result.kind, content: result.content };
    }, "executor")
  };
}
__name(buildResearchTools, "buildResearchTools");

// src/db/memory.ts
function isStatus(value) {
  return value === "pending" || value === "active" || value === "failed";
}
__name(isStatus, "isStatus");
function isVectorState(value) {
  return value === "pending" || value === "synced" || value === "failed";
}
__name(isVectorState, "isVectorState");
function toMemory(row) {
  const status = row["status"];
  if (typeof status !== "string" || !isStatus(status)) return null;
  return {
    id: String(row["id"]),
    userId: Number(row["user_id"]),
    content: String(row["content"]),
    status,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"])
  };
}
__name(toMemory, "toMemory");
function toEmbedding(row) {
  const state = row["vector_state"];
  if (typeof state !== "string" || !isVectorState(state)) return null;
  return {
    memoryId: String(row["memory_id"]),
    vectorId: String(row["vector_id"]),
    providerId: String(row["provider_id"]),
    vendorModel: String(row["vendor_model"]),
    dimensions: Number(row["dimensions"]),
    vectorState: state,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"])
  };
}
__name(toEmbedding, "toEmbedding");
var D1MemoryRepository = class {
  static {
    __name(this, "D1MemoryRepository");
  }
  db;
  constructor(db) {
    this.db = db;
  }
  async insertMemory(input) {
    try {
      const result = await this.db.prepare(
        `INSERT INTO memories (id, user_id, content, status, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`
      ).bind(input.id, input.userId, input.content, input.createdAt, input.createdAt).run();
      return (result.meta.changes ?? 0) > 0;
    } catch {
      return false;
    }
  }
  async setMemoryStatus(userId, memoryId, status, updatedAt) {
    const result = await this.db.prepare("UPDATE memories SET status = ?, updated_at = max(updated_at, ?) WHERE id = ? AND user_id = ?").bind(status, updatedAt, memoryId, userId).run();
    return (result.meta.changes ?? 0) > 0;
  }
  async upsertMemoryEmbedding(input) {
    await this.db.prepare(
      `INSERT INTO memory_embeddings (memory_id, vector_id, provider_id, vendor_model, dimensions, vector_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (memory_id) DO UPDATE SET
           vector_id = excluded.vector_id,
           provider_id = excluded.provider_id,
           vendor_model = excluded.vendor_model,
           dimensions = excluded.dimensions,
           vector_state = excluded.vector_state,
           updated_at = max(memory_embeddings.updated_at, excluded.updated_at)`
    ).bind(
      input.memoryId,
      input.vectorId,
      input.providerId,
      input.vendorModel,
      input.dimensions,
      input.vectorState,
      input.timestamp,
      input.timestamp
    ).run();
  }
  async findMemory(userId, memoryId) {
    const row = await this.db.prepare(
      `SELECT m.id, m.user_id, m.content, m.status, m.created_at, m.updated_at,
                e.memory_id, e.vector_id, e.provider_id, e.vendor_model, e.dimensions, e.vector_state,
                e.created_at AS embedding_created_at, e.updated_at AS embedding_updated_at
         FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.id = ? AND m.user_id = ?`
    ).bind(memoryId, userId).first();
    if (row === null) return null;
    const memory = toMemory(row);
    if (memory === null) return null;
    const embedding = row["vector_id"] === null || row["vector_id"] === void 0 ? null : toEmbedding({
      memory_id: row["memory_id"],
      vector_id: row["vector_id"],
      provider_id: row["provider_id"],
      vendor_model: row["vendor_model"],
      dimensions: row["dimensions"],
      vector_state: row["vector_state"],
      created_at: row["embedding_created_at"],
      updated_at: row["embedding_updated_at"]
    });
    return { memory, embedding };
  }
  async findMemoriesByVectorIds(userId, vectorIds) {
    const bounded2 = vectorIds.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128).slice(0, 100);
    if (bounded2.length === 0) return [];
    const placeholders = bounded2.map(() => "?").join(", ");
    const result = await this.db.prepare(
      `SELECT m.id, m.user_id, m.content, m.status, m.created_at, m.updated_at
         FROM memories m
         JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.user_id = ? AND m.status = 'active' AND e.vector_state = 'synced'
           AND e.vector_id IN (${placeholders})`
    ).bind(userId, ...bounded2).all();
    const out = [];
    for (const row of result.results) {
      const memory = toMemory(row);
      if (memory !== null) out.push(memory);
    }
    return out;
  }
  async listMemories(userId, limit) {
    const pageSize = Math.min(Math.max(1, Math.floor(limit)), 100);
    const result = await this.db.prepare(
      `SELECT id, user_id, content, status, created_at, updated_at
         FROM memories WHERE user_id = ? ORDER BY created_at DESC, id ASC LIMIT ?`
    ).bind(userId, pageSize).all();
    const out = [];
    for (const row of result.results) {
      const memory = toMemory(row);
      if (memory !== null) out.push(memory);
    }
    return out;
  }
  async deleteMemory(userId, memoryId) {
    const row = await this.db.prepare(
      `SELECT e.vector_id FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.id = ? AND m.user_id = ?`
    ).bind(memoryId, userId).first();
    if (row === null) return { deleted: false, vectorId: null };
    const vectorId = typeof row["vector_id"] === "string" ? row["vector_id"] : null;
    const result = await this.db.prepare("DELETE FROM memories WHERE id = ? AND user_id = ?").bind(memoryId, userId).run();
    return { deleted: (result.meta.changes ?? 0) > 0, vectorId };
  }
  async countMemories(userId) {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE user_id = ?").bind(userId).first();
    return row?.count ?? 0;
  }
  async clearMemories(userId) {
    const rows = await this.db.prepare(
      `SELECT e.vector_id FROM memories m
         JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.user_id = ?`
    ).bind(userId).all();
    const vectorIds = [];
    for (const row of rows.results) {
      if (typeof row["vector_id"] === "string") vectorIds.push(row["vector_id"]);
    }
    await this.db.prepare("DELETE FROM memories WHERE user_id = ?").bind(userId).run();
    return vectorIds;
  }
};

// src/memory/ports.ts
var MEMORY_MAX_CONTENT_CHARS = 2e3;
var MEMORY_MIN_CONTENT_CHARS = 2;
var MEMORY_MAX_QUERY_CHARS = 2e3;
var MEMORY_MAX_PER_USER = 200;
var MEMORY_DEFAULT_TOP_K = 5;
var MEMORY_MAX_TOP_K = 20;
var MEMORY_DEFAULT_MIN_SCORE = 0.35;
var MEMORY_MAX_EMBED_INPUTS = 8;
var MemoryError = class extends Error {
  static {
    __name(this, "MemoryError");
  }
  kind;
  constructor(kind) {
    super(`Memory error: ${kind}`);
    this.name = "MemoryError";
    this.kind = kind;
  }
};
function requireUserId(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new MemoryError("invalid");
  return value;
}
__name(requireUserId, "requireUserId");
function requireContent(value, max = MEMORY_MAX_CONTENT_CHARS) {
  if (typeof value !== "string") throw new MemoryError("invalid");
  const trimmed = value.trim();
  if (trimmed.length < MEMORY_MIN_CONTENT_CHARS || trimmed.length > max) throw new MemoryError("invalid");
  return trimmed;
}
__name(requireContent, "requireContent");
function clampTopK(value) {
  if (!Number.isInteger(value) || value < 1) return MEMORY_DEFAULT_TOP_K;
  return Math.min(value, MEMORY_MAX_TOP_K);
}
__name(clampTopK, "clampTopK");

// src/memory/workers-ai-embedding.ts
var WORKERS_AI_EMBEDDING_MODEL = "@cf/baai/bge-m3";
var WORKERS_AI_EMBEDDING_DIMENSIONS = 1024;
var WORKERS_AI_EMBEDDING_PROVIDER_ID = "workers-ai-bge-m3";
function isAiBinding(value) {
  return typeof value === "object" && value !== null && "run" in value && typeof value.run === "function";
}
__name(isAiBinding, "isAiBinding");
var WorkersAiEmbeddingProvider = class {
  static {
    __name(this, "WorkersAiEmbeddingProvider");
  }
  id = WORKERS_AI_EMBEDDING_PROVIDER_ID;
  model;
  dimensions = WORKERS_AI_EMBEDDING_DIMENSIONS;
  ai;
  constructor(options) {
    if (!isAiBinding(options.ai)) throw new MemoryError("unavailable");
    this.ai = options.ai;
    this.model = options.model ?? WORKERS_AI_EMBEDDING_MODEL;
  }
  async embed(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MEMORY_MAX_EMBED_INPUTS) {
      throw new MemoryError("invalid");
    }
    for (const input of inputs) {
      if (typeof input !== "string" || input.length === 0 || input.length > MEMORY_MAX_QUERY_CHARS) {
        throw new MemoryError("invalid");
      }
    }
    let result;
    try {
      result = await this.ai.run(this.model, { text: [...inputs] });
    } catch {
      throw new MemoryError("unavailable");
    }
    if (typeof result !== "object" || result === null) throw new MemoryError("unavailable");
    const record = result;
    const data = record["data"];
    if (!Array.isArray(data) || data.length !== inputs.length) throw new MemoryError("unavailable");
    const vectors = [];
    for (const entry of data) {
      if (!Array.isArray(entry) || entry.length !== this.dimensions) throw new MemoryError("unavailable");
      const values = [];
      for (const value of entry) {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new MemoryError("unavailable");
        values.push(value);
      }
      vectors.push(values);
    }
    return vectors;
  }
};

// src/memory/vectorize.ts
var MAX_UPSERT_BATCH = 100;
var MAX_DELETE_BATCH = 100;
var MAX_QUERY_TOP_K = 20;
function isVectorizeIndex(value) {
  return typeof value === "object" && value !== null && "upsert" in value && "query" in value && "deleteByIds" in value && typeof value.upsert === "function" && typeof value.query === "function" && typeof value.deleteByIds === "function";
}
__name(isVectorizeIndex, "isVectorizeIndex");
var VectorizeAdapter = class {
  static {
    __name(this, "VectorizeAdapter");
  }
  index;
  constructor(options) {
    if (!isVectorizeIndex(options.index)) throw new MemoryError("unavailable");
    this.index = options.index;
  }
  async upsert(vectors) {
    if (vectors.length === 0) return;
    if (vectors.length > MAX_UPSERT_BATCH) throw new MemoryError("invalid");
    const payload = vectors.map((v) => {
      if (typeof v.id !== "string" || v.id.length === 0 || v.id.length > 128) throw new MemoryError("invalid");
      if (!Array.isArray(v.values) || v.values.length === 0 || v.values.length > 4096) throw new MemoryError("invalid");
      for (const val of v.values) {
        if (typeof val !== "number" || !Number.isFinite(val)) throw new MemoryError("invalid");
      }
      const metadata = {};
      for (const [key, value] of Object.entries(v.metadata)) {
        if (typeof key !== "string" || key.length === 0 || key.length > 64) throw new MemoryError("invalid");
        if (typeof value !== "string") throw new MemoryError("invalid");
        metadata[key] = value;
      }
      return { id: v.id, values: v.values, metadata };
    });
    try {
      await this.index.upsert(payload);
    } catch {
      throw new MemoryError("unavailable");
    }
  }
  async query(values, options) {
    if (!Array.isArray(values) || values.length === 0 || values.length > 4096) throw new MemoryError("invalid");
    for (const val of values) {
      if (typeof val !== "number" || !Number.isFinite(val)) throw new MemoryError("invalid");
    }
    const topK = Math.min(Math.max(1, Math.floor(options.topK)), MAX_QUERY_TOP_K);
    const filter = options.filter !== void 0 ? buildFilter(options.filter) : void 0;
    let result;
    try {
      result = await this.index.query(values, {
        topK,
        returnMetadata: "indexed",
        ...filter !== void 0 ? { filter } : {}
      });
    } catch {
      throw new MemoryError("unavailable");
    }
    if (!result || !Array.isArray(result.matches)) return [];
    const out = [];
    for (const match of result.matches) {
      if (typeof match.id !== "string" || match.id.length === 0) continue;
      if (typeof match.score !== "number" || !Number.isFinite(match.score)) continue;
      const metadata = match.metadata !== void 0 ? match.metadata : void 0;
      out.push({ id: match.id, score: match.score, metadata });
    }
    return out;
  }
  async deleteByIds(ids) {
    if (ids.length === 0) return;
    const bounded2 = ids.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128).slice(0, MAX_DELETE_BATCH);
    if (bounded2.length === 0) return;
    try {
      await this.index.deleteByIds(bounded2);
    } catch {
      throw new MemoryError("unavailable");
    }
  }
};
function buildFilter(filter) {
  const out = {};
  for (const [key, value] of Object.entries(filter)) {
    if (typeof key === "string" && key.length > 0 && key.length <= 64 && typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}
__name(buildFilter, "buildFilter");

// src/memory/semantic-memory.ts
var SemanticMemoryService = class {
  static {
    __name(this, "SemanticMemoryService");
  }
  repo;
  embeddings;
  vectorIndex;
  clock;
  constructor(deps) {
    this.repo = deps.repo;
    this.embeddings = deps.embeddings;
    this.vectorIndex = deps.vectorIndex;
    this.clock = deps.clock ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  }
  get dimensions() {
    return this.embeddings.dimensions;
  }
  get providerId() {
    return this.embeddings.id;
  }
  get model() {
    return this.embeddings.model;
  }
  async store(userId, content) {
    const uid = requireUserId(userId);
    const clean = requireContent(content, MEMORY_MAX_CONTENT_CHARS);
    const count = await this.repo.countMemories(uid).catch(() => {
      throw new MemoryError("unavailable");
    });
    if (count >= MEMORY_MAX_PER_USER) throw new MemoryError("capacity");
    const memoryId = crypto.randomUUID();
    const now = this.clock();
    const inserted = await this.repo.insertMemory({ id: memoryId, userId: uid, content: clean, createdAt: now }).catch(() => {
      throw new MemoryError("unavailable");
    });
    if (!inserted) throw new MemoryError("unavailable");
    let vectors;
    try {
      vectors = await this.embeddings.embed([clean]);
    } catch {
      await this.repo.setMemoryStatus(uid, memoryId, "failed", this.clock()).catch(() => void 0);
      throw new MemoryError("unavailable");
    }
    if (!vectors || vectors.length !== 1 || !vectors[0] || vectors[0].length !== this.embeddings.dimensions) {
      await this.repo.setMemoryStatus(uid, memoryId, "failed", this.clock()).catch(() => void 0);
      throw new MemoryError("unavailable");
    }
    const vectorId = `mem:${memoryId}`;
    try {
      await this.vectorIndex.upsert([{
        id: vectorId,
        values: vectors[0],
        metadata: { owner_id: String(uid) }
      }]);
    } catch {
      await this.repo.setMemoryStatus(uid, memoryId, "failed", this.clock()).catch(() => void 0);
      await this.repo.upsertMemoryEmbedding({
        memoryId,
        vectorId,
        providerId: this.embeddings.id,
        vendorModel: this.embeddings.model,
        dimensions: this.embeddings.dimensions,
        vectorState: "failed",
        timestamp: this.clock()
      }).catch(() => void 0);
      throw new MemoryError("unavailable");
    }
    await this.repo.upsertMemoryEmbedding({
      memoryId,
      vectorId,
      providerId: this.embeddings.id,
      vendorModel: this.embeddings.model,
      dimensions: this.embeddings.dimensions,
      vectorState: "synced",
      timestamp: this.clock()
    }).catch(() => void 0);
    await this.repo.setMemoryStatus(uid, memoryId, "active", this.clock()).catch(() => void 0);
    return memoryId;
  }
  async recall(userId, query, topK = MEMORY_DEFAULT_TOP_K, minScore = MEMORY_DEFAULT_MIN_SCORE) {
    const uid = requireUserId(userId);
    const cleanQuery = requireContent(query, MEMORY_MAX_CONTENT_CHARS);
    const k = clampTopK(topK);
    let queryVectors;
    try {
      queryVectors = await this.embeddings.embed([cleanQuery]);
    } catch {
      return [];
    }
    if (!queryVectors || queryVectors.length !== 1 || !queryVectors[0]) return [];
    let matches;
    try {
      matches = await this.vectorIndex.query(queryVectors[0], {
        topK: k,
        filter: { owner_id: String(uid) }
      });
    } catch {
      return [];
    }
    if (!matches || matches.length === 0) return [];
    const vectorIds = matches.filter((m) => m.score >= minScore).map((m) => m.id);
    if (vectorIds.length === 0) return [];
    const records = await this.repo.findMemoriesByVectorIds(uid, vectorIds).catch(() => []);
    const memById = /* @__PURE__ */ new Map();
    for (const rec of records) {
      memById.set(`mem:${rec.id}`, rec);
      memById.set(rec.id, rec);
    }
    const hits = [];
    for (const match of matches) {
      if (match.score < minScore) continue;
      const rec = memById.get(match.id);
      if (!rec) continue;
      if (rec.userId !== uid) continue;
      if (rec.status !== "active") continue;
      hits.push({ content: rec.content, score: match.score });
    }
    hits.sort((a, b) => b.score - a.score || (a.content < b.content ? -1 : a.content > b.content ? 1 : 0));
    return hits.slice(0, k);
  }
  async list(userId, limit = 20) {
    const uid = requireUserId(userId);
    const records = await this.repo.listMemories(uid, Math.min(limit, 100)).catch(() => []);
    return records.map((r) => ({ id: r.id, content: r.content, status: r.status, createdAt: r.createdAt }));
  }
  async delete(userId, memoryId) {
    const uid = requireUserId(userId);
    if (typeof memoryId !== "string" || memoryId.length === 0 || memoryId.length > 128) throw new MemoryError("invalid");
    const result = await this.repo.deleteMemory(uid, memoryId).catch(() => null);
    if (result === null) return false;
    if (result.deleted && result.vectorId) {
      await this.vectorIndex.deleteByIds([result.vectorId]).catch(() => void 0);
    }
    return result.deleted;
  }
  async clear(userId) {
    const uid = requireUserId(userId);
    const vectorIds = await this.repo.clearMemories(uid).catch(() => []);
    if (vectorIds.length > 0) {
      await this.vectorIndex.deleteByIds(vectorIds).catch(() => void 0);
    }
    return vectorIds.length;
  }
  renderContext(hits, maxChars = 2e3) {
    if (hits.length === 0) return "";
    const lines = hits.map((h) => `- ${h.content}`).join("\n").slice(0, maxChars);
    return `<untrusted_memory>
${lines}
</untrusted_memory>`;
  }
};

// src/orchestration/production.ts
var D1ProviderDirectorySnapshot = class {
  static {
    __name(this, "D1ProviderDirectorySnapshot");
  }
  directory;
  constructor(directory) {
    this.directory = directory;
  }
  async listRoutingProviders() {
    const entries = await this.directory.listEnabledProviders().catch(() => []);
    return entries.map((entry) => ({ id: entry.id, enabled: true, weight: entry.weight }));
  }
};
function buildProductionProvider(db, env) {
  const masterSecret = env.CREDENTIAL_MASTER_SECRET;
  if (typeof masterSecret !== "string" || masterSecret.length === 0) return null;
  return new AIRouter({
    directory: new D1ProviderDirectory(db),
    credentialStore: new D1CredentialStore(db),
    health: new InMemoryRouterHealth(),
    masterSecret
  });
}
__name(buildProductionProvider, "buildProductionProvider");
function buildProductionUsageRecorder(db, userId, requestId, now) {
  return {
    record: /* @__PURE__ */ __name(async (input) => {
      if (!/^[a-z0-9-]{1,64}$/.test(input.providerId)) return;
      if (typeof input.vendorModel !== "string" || input.vendorModel.length === 0 || input.vendorModel.length > 128) return;
      for (const tokens of [input.inputTokens, input.outputTokens]) {
        if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > 9007199254740991) return;
      }
      await recordUsageEvent(db, {
        id: `req:${requestId.slice(0, 100)}`,
        userId,
        providerId: input.providerId,
        vendorModel: input.vendorModel,
        requestId: input.requestId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        createdAt: now()
      }).catch(() => void 0);
    }, "record")
  };
}
__name(buildProductionUsageRecorder, "buildProductionUsageRecorder");
function buildProductionResearchTools() {
  return buildResearchTools();
}
__name(buildProductionResearchTools, "buildProductionResearchTools");
function buildProductionMemoryService(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") return null;
  if (!env.AI || typeof env.AI.run !== "function") return null;
  if (!env.VECTORIZE || typeof env.VECTORIZE.upsert !== "function") return null;
  try {
    const embeddings = new WorkersAiEmbeddingProvider({ ai: env.AI });
    const vectorIndex = new VectorizeAdapter({ index: env.VECTORIZE });
    const repo = new D1MemoryRepository(env.DB);
    return new SemanticMemoryService({ repo, embeddings, vectorIndex });
  } catch {
    return null;
  }
}
__name(buildProductionMemoryService, "buildProductionMemoryService");
function buildProductionMemoryRecall(env, userId) {
  const service = buildProductionMemoryService(env);
  if (service === null) return void 0;
  return async (query) => {
    const hits = await service.recall(userId, query);
    return service.renderContext(hits);
  };
}
__name(buildProductionMemoryRecall, "buildProductionMemoryRecall");

// src/telegram/control-plane.ts
var START_COMMAND = "/start";
var HELP_COMMAND = "/help";
function isControlPlaneCommand(text) {
  const trimmed = text.trim();
  return trimmed === START_COMMAND || trimmed === HELP_COMMAND;
}
__name(isControlPlaneCommand, "isControlPlaneCommand");
async function handleControlPlaneCommand(db, telegramUserId, text) {
  const trimmed = text.trim();
  const role = await getTelegramUserRole(db, telegramUserId).catch(() => null);
  const isAdmin = role === "OWNER" || role === "ADMIN";
  if (trimmed === START_COMMAND) {
    let message = "Welcome to HawkTalk! Send me a message and I will do my best to help you.";
    if (isAdmin) {
      message += "\n\nYou have admin privileges. Use /admin to open the Admin Panel.";
    }
    return { text: message };
  }
  if (trimmed === HELP_COMMAND) {
    const lines = [
      "HawkTalk Help",
      "",
      "/start - Welcome message",
      "/help - Show this help",
      "/fast <question> - Quick response",
      "/smart <question> - Detailed response",
      "/research <question> - Web research",
      "/remember <text> - Save a memory",
      "/memories - List memories",
      "/forget - Clear memories"
    ];
    if (isAdmin) {
      lines.push("/admin - Open Admin Panel");
    }
    return { text: lines.join("\n") };
  }
  return { text: "Unknown command." };
}
__name(handleControlPlaneCommand, "handleControlPlaneCommand");

// src/telegram/webhook.ts
var TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";
var WEBHOOK_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
var MAX_BODY_BYTES = 256 * 1024;
function timingSafeEqualString(a, b) {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
__name(timingSafeEqualString, "timingSafeEqualString");
async function handleTelegramWebhook(request, env, requestId, deps = {}) {
  const now = deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
  }
  const serverSecret = env.TELEGRAM_WEBHOOK_SECRET;
  if (typeof serverSecret !== "string" || serverSecret.length === 0) {
    console.error(JSON.stringify({ event: "webhook_misconfigured", request_id: requestId }));
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
  const presentedSecret = request.headers.get(WEBHOOK_SECRET_HEADER);
  if (presentedSecret === null || !timingSafeEqualString(presentedSecret, serverSecret)) {
    console.error(JSON.stringify({ event: "webhook_unauthorized", request_id: requestId }));
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    console.error(JSON.stringify({ event: "webhook_bad_request", request_id: requestId }));
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    console.error(JSON.stringify({ event: "webhook_body_read_failed", request_id: requestId }));
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    console.error(
      JSON.stringify({
        event: raw.length === 0 ? "webhook_empty_body" : "webhook_body_too_large",
        request_id: requestId
      })
    );
    return Response.json({ error: raw.length === 0 ? "Bad request" : "Payload too large" }, { status: raw.length === 0 ? 400 : 413 });
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.error(JSON.stringify({ event: "webhook_malformed_json", request_id: requestId }));
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const update = parseTelegramUpdate(payload);
  if (update === null) {
    console.error(JSON.stringify({ event: "webhook_invalid_update", request_id: requestId }));
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const db = env.DB;
  if (!db || typeof db.prepare !== "function") {
    console.error(JSON.stringify({ event: "webhook_missing_binding", request_id: requestId }));
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
  const isControlPlaneUpdate = update.kind === "admin_callback" || update.kind === "text_message" && (update.text.trim() === ADMIN_COMMAND || isControlPlaneCommand(update.text));
  const kind = isControlPlaneUpdate ? "admin" : update.kind === "text_message" ? "text" : "unsupported";
  const updateUserId = update.kind === "text_message" || update.kind === "admin_callback" ? update.userId : null;
  let claimed;
  try {
    claimed = await claimUpdate(db, update.updateId, updateUserId, kind, now());
  } catch {
    console.error(JSON.stringify({ event: "webhook_claim_failed", request_id: requestId }));
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
  if (!claimed) {
    if (isControlPlaneUpdate) return Response.json({ ok: true });
    const botToken2 = env.TELEGRAM_BOT_TOKEN;
    if (deps.flow !== void 0 && update.kind === "text_message" && update.chatType === "private" && typeof botToken2 === "string" && botToken2.length > 0) {
      try {
        const internalUserId = await findInternalUserIdByTelegramId(db, update.userId);
        if (internalUserId !== null) {
          const flowDeps = deps.flow(requestId, internalUserId);
          const text = await getCompletedAssistantText(update.updateId, flowDeps);
          if (text !== null) {
            await sendTelegramMessage({ token: botToken2, chatId: update.chatId, text, fetchImpl: deps.fetchImpl });
            return Response.json({ ok: true });
          }
        }
      } catch {
        console.error(JSON.stringify({ event: "webhook_redelivery_failed", request_id: requestId }));
        return Response.json({ error: "Something went wrong" }, { status: 500 });
      }
    }
    return Response.json({ ok: true });
  }
  if (update.kind === "unsupported") {
    return Response.json({ ok: true });
  }
  if (update.chatType !== "private") {
    return Response.json({ ok: true });
  }
  if (isControlPlaneUpdate) {
    if (update.kind === "text_message" && isControlPlaneCommand(update.text)) {
      const cpBotToken = env.TELEGRAM_BOT_TOKEN;
      if (typeof cpBotToken !== "string" || cpBotToken.length === 0) {
        console.error(JSON.stringify({ event: "webhook_misconfigured", request_id: requestId }));
        return Response.json({ error: "Something went wrong" }, { status: 500 });
      }
      try {
        await upsertTelegramUser(
          db,
          { telegramUserId: update.userId, username: update.username, displayName: update.displayName },
          now(),
          env.OWNER_TELEGRAM_ID
        );
        const result = await handleControlPlaneCommand(db, update.userId, update.text);
        await sendTelegramMessage({
          token: cpBotToken,
          chatId: update.chatId,
          text: result.text,
          replyMarkup: result.keyboard ? { inline_keyboard: result.keyboard } : void 0,
          fetchImpl: deps.fetchImpl
        });
        return Response.json({ ok: true });
      } catch {
        console.error(JSON.stringify({ event: "command_handling_failed", request_id: requestId }));
        return Response.json({ error: "Something went wrong" }, { status: 500 });
      }
    }
    const adminService = deps.adminService;
    if (adminService === void 0) return Response.json({ ok: true });
    const botToken2 = env.TELEGRAM_BOT_TOKEN;
    if (typeof botToken2 !== "string" || botToken2.length === 0) {
      console.error(JSON.stringify({ event: "webhook_misconfigured", request_id: requestId }));
      return Response.json({ error: "Something went wrong" }, { status: 500 });
    }
    try {
      if (update.kind === "admin_callback") {
        const outcome2 = await handleAdminCallback(db, adminService, update.userId, update.data);
        if (outcome2.kind === "view") {
          await sendTelegramMessage({
            token: botToken2,
            chatId: update.chatId,
            text: outcome2.view.text,
            replyMarkup: { inline_keyboard: outcome2.view.keyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) },
            fetchImpl: deps.fetchImpl
          });
        }
        await answerCallbackQuery({ token: botToken2, callbackQueryId: update.callbackQueryId, text: outcome2.kind === "answer" ? outcome2.text : void 0, fetchImpl: deps.fetchImpl });
        return Response.json({ ok: true });
      }
      const outcome = await handleAdminCommand(db, adminService, update.userId);
      const text = outcome.kind === "view" ? outcome.view.text : outcome.text;
      const keyboard = outcome.kind === "view" ? outcome.view.keyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) : void 0;
      await sendTelegramMessage({
        token: botToken2,
        chatId: update.chatId,
        text,
        replyMarkup: keyboard === void 0 ? void 0 : { inline_keyboard: keyboard },
        fetchImpl: deps.fetchImpl
      });
      return Response.json({ ok: true });
    } catch {
      console.error(JSON.stringify({ event: "webhook_admin_failed", request_id: requestId }));
      return Response.json({ error: "Something went wrong" }, { status: 500 });
    }
  }
  try {
    await upsertTelegramUser(
      db,
      { telegramUserId: update.userId, username: update.username, displayName: update.displayName },
      now(),
      env.OWNER_TELEGRAM_ID
    );
  } catch {
    console.error(JSON.stringify({ event: "webhook_user_upsert_failed", request_id: requestId }));
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (typeof botToken !== "string" || botToken.length === 0) {
    await releaseUpdateClaim(db, update.updateId).catch(() => void 0);
    console.error(JSON.stringify({ event: "webhook_misconfigured", request_id: requestId }));
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
  if (deps.flow === void 0) {
    try {
      await sendTelegramMessage({ token: botToken, chatId: update.chatId, text: TRANSPORT_ACK_TEXT, fetchImpl: deps.fetchImpl });
    } catch {
      await releaseUpdateClaim(db, update.updateId);
      console.error(JSON.stringify({ event: "webhook_reply_failed", request_id: requestId }));
      return Response.json({ error: "Something went wrong" }, { status: 500 });
    }
    return Response.json({ ok: true });
  }
  const flow = deps.flow;
  let assistantText;
  let flowErrorKind = null;
  try {
    const internalUserId = await findInternalUserIdByTelegramId(db, update.userId);
    if (internalUserId === null) {
      console.error(JSON.stringify({ event: "webhook_user_missing", request_id: requestId }));
      throw new ConversationFlowError("conversation_failed");
    }
    const memCmd = parseMemoryCommand(update.text);
    if (memCmd !== null) {
      const memService = buildProductionMemoryService(env);
      if (memService === null) {
        assistantText = "Memory is currently unavailable.";
      } else {
        const result = await handleMemoryCommand(memCmd, internalUserId, memService);
        assistantText = result.text;
      }
    } else {
      const userCommand = parseUserCommand(update.text);
      const flowDeps = flow(requestId, internalUserId);
      if (userCommand !== null) {
        flowDeps.routingProfile = userCommand.profile;
        if (userCommand.query.length === 0) {
          assistantText = MODE_COMMAND_USAGE_HINT;
        } else {
          const result = await handleUserTextMessage(update.updateId, userCommand.query, flowDeps);
          if (result.decision === "unavailable") throw new ConversationFlowError("conversation_failed");
          assistantText = result.assistantText;
        }
      } else {
        const result = await handleUserTextMessage(update.updateId, update.text, flowDeps);
        if (result.decision === "unavailable") throw new ConversationFlowError("conversation_failed");
        assistantText = result.assistantText;
      }
    }
  } catch (error) {
    if (error instanceof ConversationFlowError) flowErrorKind = error.kind;
    if (flowErrorKind !== null && PRE_GENERATION_ERROR_KINDS.includes(flowErrorKind)) {
      await releaseUpdateClaim(db, update.updateId).catch(() => void 0);
    }
    const logEvent = "webhook_flow_failed";
    console.error(JSON.stringify({ event: logEvent, kind: flowErrorKind, request_id: requestId }));
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
  try {
    await sendTelegramMessage({ token: botToken, chatId: update.chatId, text: assistantText, fetchImpl: deps.fetchImpl });
  } catch {
    console.error(JSON.stringify({ event: "webhook_reply_failed", request_id: requestId }));
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
__name(handleTelegramWebhook, "handleTelegramWebhook");

// src/conversation/validation.ts
var ConversationServiceError = class extends Error {
  constructor(code) {
    super(`Conversation error: ${code}`);
    this.code = code;
    this.name = "ConversationServiceError";
  }
  code;
  static {
    __name(this, "ConversationServiceError");
  }
};
function invalid() {
  throw new ConversationServiceError("invalid_request");
}
__name(invalid, "invalid");
function exactObject(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return { ...value };
}
__name(exactObject, "exactObject");
function requireUserId2(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}
__name(requireUserId2, "requireUserId");
function isUuidV4(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
__name(isUuidV4, "isUuidV4");
function requireId(value) {
  if (!isUuidV4(value)) invalid();
  return value;
}
__name(requireId, "requireId");
function requireTitle(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) invalid();
  return value;
}
__name(requireTitle, "requireTitle");
function requireLimit(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) invalid();
  return value;
}
__name(requireLimit, "requireLimit");
function requireMessage(value, keys = ["role", "content"]) {
  const row = exactObject(value, keys);
  const role = row["role"];
  const inputContent = row["content"];
  if (role !== "system" && role !== "user" && role !== "assistant") invalid();
  if (typeof inputContent !== "string" || inputContent.length === 0 || inputContent.length > MAX_MESSAGE_CHARS) invalid();
  return { role, content: inputContent };
}
__name(requireMessage, "requireMessage");
async function repositoryCall(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ConversationServiceError) throw error;
    throw new ConversationServiceError("internal");
  }
}
__name(repositoryCall, "repositoryCall");

// src/conversation/service.ts
var MAX_HISTORY_MESSAGES = 100;
var MAX_HISTORY_MESSAGE_CHARS = MAX_MESSAGE_CHARS;
var MAX_HISTORY_TOTAL_CHARS = 1e5;
function generateConversationId() {
  return crypto.randomUUID();
}
__name(generateConversationId, "generateConversationId");
function generateMessageId() {
  return crypto.randomUUID();
}
__name(generateMessageId, "generateMessageId");
function failNotFound() {
  throw new ConversationServiceError("not_found");
}
__name(failNotFound, "failNotFound");
var ConversationService = class {
  static {
    __name(this, "ConversationService");
  }
  repository;
  clock;
  constructor(repository, clock) {
    this.repository = repository;
    this.clock = clock ?? new RuntimeClock();
  }
  async createConversation(userId, title) {
    const owner = requireUserId2(userId);
    const titleChars = requireTitle(title);
    const timestamp = this.clock.now();
    return repositoryCall(async () => {
      const row = await this.repository.createConversation({ userId: owner, id: generateConversationId(), title: titleChars, timestamp });
      if (row === null) throw new ConversationServiceError("conflict");
      return row;
    });
  }
  async getConversation(userId, conversationId) {
    const owner = requireUserId2(userId);
    const id = requireId(conversationId);
    return repositoryCall(async () => {
      const row = await this.repository.getConversation(owner, id);
      if (row === null) failNotFound();
      return row;
    });
  }
  async listConversations(userId, limit) {
    const owner = requireUserId2(userId);
    const pageSize = requireLimit(limit);
    return repositoryCall(() => this.repository.listConversations(owner, pageSize));
  }
  async renameConversation(userId, conversationId, title) {
    const owner = requireUserId2(userId);
    const id = requireId(conversationId);
    const titleChars = requireTitle(title);
    const timestamp = this.clock.now();
    return repositoryCall(async () => {
      const row = await this.repository.renameConversation(owner, id, titleChars, timestamp);
      if (row === null) failNotFound();
      return row;
    });
  }
  async archiveConversation(userId, conversationId) {
    const owner = requireUserId2(userId);
    const id = requireId(conversationId);
    const timestamp = this.clock.now();
    return repositoryCall(async () => {
      const row = await this.repository.archiveConversation(owner, id, timestamp);
      if (row === null) failNotFound();
      return row;
    });
  }
  async deleteConversation(userId, conversationId) {
    const owner = requireUserId2(userId);
    const id = requireId(conversationId);
    return repositoryCall(() => this.repository.deleteConversation(owner, id));
  }
  async getHistory(userId, conversationId, limit) {
    const owner = requireUserId2(userId);
    const id = requireId(conversationId);
    const historyLimit = requireLimit(limit);
    return repositoryCall(async () => {
      const messages = await this.repository.getConversationHistory(owner, id, historyLimit);
      let total = 0;
      const newestFirst = [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message === void 0) break;
        if (message.content.length > MAX_HISTORY_MESSAGE_CHARS || total + message.content.length > MAX_HISTORY_TOTAL_CHARS) break;
        total += message.content.length;
        newestFirst.push(message);
      }
      return newestFirst.reverse();
    });
  }
  async getContext(userId, conversationId, limit) {
    const history = await this.getHistory(userId, conversationId, limit);
    return history.map((message) => ({ role: message.role, content: message.content }));
  }
  async appendMessage(userId, conversationId, input) {
    const owner = requireUserId2(userId);
    const id = requireId(conversationId);
    const timestamp = this.clock.now();
    const fields = exactObject(input, ["role", "content"]);
    const message = requireMessage(fields);
    return repositoryCall(async () => {
      const row = await this.repository.appendMessage(owner, id, { id: generateMessageId(), role: message.role, content: message.content, timestamp });
      if (row === null) failNotFound();
      return row;
    });
  }
  async getMessageText(userId, conversationId, messageId) {
    const owner = requireUserId2(userId);
    const conversation = requireId(conversationId);
    const message = requireId(messageId);
    return repositoryCall(async () => {
      const row = await this.repository.getMessage(owner, conversation, message);
      return row?.content ?? null;
    });
  }
  async deleteMessage(userId, conversationId, messageId) {
    const owner = requireUserId2(userId);
    const conversation = requireId(conversationId);
    const message = requireId(messageId);
    return repositoryCall(() => this.repository.deleteMessage(owner, conversation, message));
  }
};

// src/orchestration/conversation-orchestrator.ts
var DEFAULT_CONVERSATION_TITLE = "Default conversation";
var D1ConversationOrchestrator = class {
  static {
    __name(this, "D1ConversationOrchestrator");
  }
  db;
  service;
  constructor(db, repository, clock) {
    this.db = db;
    this.service = new ConversationService(repository, clock);
  }
  async resolveDefaultConversation(userId) {
    const mapped = await this.readMappedConversation(userId);
    if (mapped !== null) return { conversation: mapped, created: false };
    const conversation = await this.service.createConversation(userId, DEFAULT_CONVERSATION_TITLE);
    await this.bindDefault(userId, conversation.id);
    const rebound = await this.readMappedConversation(userId);
    if (rebound !== null) return { conversation: rebound, created: rebound.id === conversation.id };
    return { conversation, created: true };
  }
  async readMappedConversation(userId) {
    const row = await this.db.prepare(
      `SELECT c.id, c.user_id, c.title, c.status, c.created_at, c.updated_at
         FROM default_conversations d JOIN conversations c ON c.id = d.conversation_id AND c.user_id = d.user_id
         WHERE d.user_id = ? AND c.status = 'active'`
    ).bind(userId).first();
    if (row === null) return null;
    return {
      id: String(row["id"]),
      user_id: Number(row["user_id"]),
      title: String(row["title"]),
      status: "active",
      created_at: String(row["created_at"]),
      updated_at: String(row["updated_at"])
    };
  }
  /** Guarded upsert: writes only when the user has no active mapped conversation. */
  async bindDefault(userId, conversationId) {
    await this.db.prepare(
      `INSERT INTO default_conversations (user_id, conversation_id)
         SELECT ?, ? WHERE NOT EXISTS (
           SELECT 1 FROM default_conversations d
           JOIN conversations c ON c.id = d.conversation_id
           WHERE d.user_id = ? AND c.status = 'active'
         )
         ON CONFLICT (user_id) DO UPDATE SET conversation_id = excluded.conversation_id`
    ).bind(userId, conversationId, userId).run();
  }
  async appendMessage(userId, conversationId, input) {
    return this.service.appendMessage(userId, conversationId, input);
  }
  async getContext(userId, conversationId, limit) {
    const bounded2 = Math.min(Math.max(1, limit), MAX_HISTORY_MESSAGES);
    return this.service.getContext(userId, conversationId, bounded2);
  }
  async getMessageText(userId, conversationId, messageId) {
    const row = await this.service.getMessageText(userId, conversationId, messageId);
    return row;
  }
};

// src/orchestration/processing-d1.ts
function isProcessingState(value) {
  return value === "claimed" || value === "generating" || value === "completed" || value === "failed";
}
__name(isProcessingState, "isProcessingState");
function toRecord(row) {
  if (row === null) return null;
  const state = row["processing_state"];
  if (typeof state !== "string" || !isProcessingState(state)) return null;
  const conversationId = row["conversation_id"];
  const assistantMessageId = row["assistant_message_id"];
  return {
    updateId: typeof row["update_id"] === "number" ? row["update_id"] : -1,
    state,
    conversationId: typeof conversationId === "string" ? conversationId : null,
    assistantMessageId: typeof assistantMessageId === "string" ? assistantMessageId : null
  };
}
__name(toRecord, "toRecord");
var D1ProcessingRepository = class {
  static {
    __name(this, "D1ProcessingRepository");
  }
  db;
  constructor(db) {
    this.db = db;
  }
  async markGenerating(updateId, conversationId) {
    const result = await this.db.prepare(
      `UPDATE processed_updates SET processing_state = 'generating', conversation_id = ?
         WHERE update_id = ? AND processing_state = 'claimed'`
    ).bind(conversationId, updateId).run();
    return (result.meta.changes ?? 0) > 0;
  }
  async completeWithAssistantMessage(updateId, assistantMessageId) {
    const result = await this.db.prepare(
      `UPDATE processed_updates SET processing_state = 'completed', assistant_message_id = ?
         WHERE update_id = ? AND processing_state = 'generating'`
    ).bind(assistantMessageId, updateId).run();
    return (result.meta.changes ?? 0) > 0;
  }
  async markFailed(updateId) {
    const result = await this.db.prepare(
      `UPDATE processed_updates SET processing_state = 'failed'
         WHERE update_id = ? AND processing_state = 'generating'`
    ).bind(updateId).run();
    return (result.meta.changes ?? 0) > 0;
  }
  async getProcessingRecord(updateId) {
    const row = await this.db.prepare("SELECT update_id, processing_state, conversation_id, assistant_message_id FROM processed_updates WHERE update_id = ?").bind(updateId).first();
    return toRecord(row);
  }
};

// src/db/conversation-d1.ts
function isConversationRow(value) {
  if (typeof value !== "object" || value === null) return false;
  const row = value;
  return typeof row["id"] === "string" && typeof row["user_id"] === "number" && typeof row["title"] === "string" && (row["status"] === "active" || row["status"] === "archived") && typeof row["created_at"] === "string" && typeof row["updated_at"] === "string";
}
__name(isConversationRow, "isConversationRow");
function isMessageRow(value) {
  if (typeof value !== "object" || value === null) return false;
  const row = value;
  return typeof row["id"] === "string" && typeof row["conversation_id"] === "string" && typeof row["user_id"] === "number" && typeof row["seq"] === "number" && (row["role"] === "system" || row["role"] === "user" || row["role"] === "assistant") && typeof row["content"] === "string" && typeof row["created_at"] === "string";
}
__name(isMessageRow, "isMessageRow");
var D1ConversationRepository = class {
  static {
    __name(this, "D1ConversationRepository");
  }
  db;
  constructor(db) {
    this.db = db;
  }
  async createConversation(input) {
    const ts = input.timestamp ?? (/* @__PURE__ */ new Date()).toISOString();
    try {
      await this.db.prepare("INSERT INTO conversations (id, user_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(input.id, input.userId, input.title, "active", ts, ts).run();
    } catch {
      return null;
    }
    const row = await this.db.prepare("SELECT id, user_id, title, status, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?").bind(input.id, input.userId).first();
    return isConversationRow(row) ? row : null;
  }
  async getConversation(userId, conversationId) {
    const row = await this.db.prepare("SELECT id, user_id, title, status, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?").bind(conversationId, userId).first();
    return isConversationRow(row) ? row : null;
  }
  async listConversations(userId, limit) {
    const result = await this.db.prepare("SELECT id, user_id, title, status, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, id ASC LIMIT ?").bind(userId, limit).all();
    return result.results.filter(isConversationRow);
  }
  async renameConversation(userId, conversationId, title, timestamp) {
    return this.db.prepare("UPDATE conversations SET title = ?, updated_at = max(updated_at, ?) WHERE id = ? AND user_id = ? RETURNING id, user_id, title, status, created_at, updated_at").bind(title, timestamp, conversationId, userId).first();
  }
  async archiveConversation(userId, conversationId, timestamp) {
    return this.db.prepare("UPDATE conversations SET status = 'archived', updated_at = max(updated_at, ?) WHERE id = ? AND user_id = ? RETURNING id, user_id, title, status, created_at, updated_at").bind(timestamp, conversationId, userId).first();
  }
  async deleteConversation(userId, conversationId) {
    const result = await this.db.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").bind(conversationId, userId).run();
    return (result.meta.changes ?? 0) > 0;
  }
  async getConversationHistory(userId, conversationId, limit) {
    requireUserId2(userId);
    requireId(conversationId);
    const historyLimit = requireLimit(limit);
    const conversation = await this.getConversation(userId, conversationId);
    if (conversation === null) return [];
    const result = await this.db.prepare("SELECT id, conversation_id, user_id, seq, role, content, created_at FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY seq DESC LIMIT ?").bind(conversationId, userId, historyLimit).all();
    return result.results.filter(isMessageRow).reverse();
  }
  async appendMessage(userId, conversationId, input) {
    requireUserId2(userId);
    requireId(conversationId);
    const id = requireId(input.id);
    const now = input.timestamp ?? (/* @__PURE__ */ new Date()).toISOString();
    const message = requireMessage(input, ["id", "role", "content", "timestamp"]);
    return repositoryCall(async () => {
      const row = await this.db.prepare(
        `INSERT INTO messages (id, conversation_id, user_id, seq, role, content, created_at)
         SELECT ?, id, user_id, last_seq + 1, ?, ?, max(updated_at, ?)
         FROM conversations WHERE id = ? AND user_id = ? AND status = 'active'
         RETURNING id, conversation_id, user_id, seq, role, content, created_at`
      ).bind(id, message.role, message.content, now, conversationId, userId).first();
      return row === null ? null : { ...row };
    });
  }
  async getMessage(userId, conversationId, messageId) {
    requireUserId2(userId);
    requireId(conversationId);
    requireId(messageId);
    const row = await this.db.prepare("SELECT id, conversation_id, user_id, seq, role, content, created_at FROM messages WHERE id = ? AND conversation_id = ? AND user_id = ?").bind(messageId, conversationId, userId).first();
    return isMessageRow(row) ? row : null;
  }
  async deleteMessage(userId, conversationId, messageId) {
    const conversation = await this.getConversation(userId, conversationId);
    if (conversation === null) return false;
    const result = await this.db.prepare("DELETE FROM messages WHERE id = ? AND conversation_id = ? AND user_id = ?").bind(messageId, conversationId, userId).run();
    return (result.meta.changes ?? 0) > 0;
  }
};

// src/admin/types.ts
var ADMIN_CAPABILITIES = [
  "view_dashboard",
  "view_users",
  "view_providers",
  "view_credentials",
  "view_policies",
  "view_tools",
  "view_audit",
  "manage_ordinary_users",
  "manage_providers",
  "edit_ordinary_policies"
];
var OWNER_CAPABILITIES = [
  ...ADMIN_CAPABILITIES,
  "manage_privileged_users",
  "edit_privileged_policies",
  "delete_credentials",
  "view_usage",
  "edit_prices"
];
function capabilitiesFor(role) {
  return role === "OWNER" ? OWNER_CAPABILITIES : ADMIN_CAPABILITIES;
}
__name(capabilitiesFor, "capabilitiesFor");

// src/db/admin-users.ts
var USER_ROLES = ["OWNER", "ADMIN", "VIP", "USER", "BLOCKED"];
function isUserRole(value) {
  return typeof value === "string" && USER_ROLES.includes(value);
}
__name(isUserRole, "isUserRole");
function toRole(value) {
  return isUserRole(value) ? value : "USER";
}
__name(toRole, "toRole");
async function countUsers(db) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM users").first();
  return row?.count ?? 0;
}
__name(countUsers, "countUsers");
async function countUsersByRole(db) {
  const rows = await db.prepare("SELECT role, COUNT(*) AS count FROM users GROUP BY role").all();
  const out = { OWNER: 0, ADMIN: 0, VIP: 0, USER: 0, BLOCKED: 0 };
  for (const row of rows.results) out[toRole(row.role)] = row.count;
  return out;
}
__name(countUsersByRole, "countUsersByRole");
async function listUsersPage(db, afterId, pageSize) {
  const size = Math.min(Math.max(1, Math.floor(pageSize)), 20);
  const result = afterId === null ? await db.prepare("SELECT * FROM users ORDER BY id ASC LIMIT ?").bind(size + 1).all() : await db.prepare("SELECT * FROM users WHERE id > ? ORDER BY id ASC LIMIT ?").bind(afterId, size + 1).all();
  const rows = result.results;
  const hasMore = rows.length > size;
  const users = rows.slice(0, size).map((row) => toAdminUserRow(row));
  const last = users.at(-1);
  return { users, nextCursor: hasMore && last !== void 0 ? last.id : null };
}
__name(listUsersPage, "listUsersPage");
async function findUserById(db, userId) {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  return row === null ? null : toAdminUserRow(row);
}
__name(findUserById, "findUserById");
function toAdminUserRow(row) {
  return {
    id: Number(row["id"]),
    telegram_user_id: Number(row["telegram_user_id"]),
    username: typeof row["username"] === "string" ? row["username"] : null,
    display_name: typeof row["display_name"] === "string" ? row["display_name"] : null,
    role: toRole(row["role"]),
    status: typeof row["status"] === "string" ? row["status"] : "active",
    created_at: String(row["created_at"]),
    last_seen: String(row["last_seen"])
  };
}
__name(toAdminUserRow, "toAdminUserRow");
async function countOwners(db) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'OWNER' AND status = 'active'").first();
  return row?.count ?? 0;
}
__name(countOwners, "countOwners");

// src/admin/authorization.ts
function isPrivilegedTarget(role) {
  return role === "OWNER" || role === "ADMIN" || role === "BLOCKED";
}
__name(isPrivilegedTarget, "isPrivilegedTarget");
async function authorizeAdmin(db, actorUserId, action) {
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    return { ok: false, kind: "not_authorized" };
  }
  let role;
  try {
    const user = await findUserById(db, actorUserId);
    if (user === null || user.status !== "active") return { ok: false, kind: "not_authorized" };
    role = user.role;
    if (role !== "OWNER" && role !== "ADMIN") return { ok: false, kind: "not_authorized" };
  } catch {
    return { ok: false, kind: "storage_failed" };
  }
  if (role === "OWNER") return { ok: true, actor: { userId: actorUserId, role } };
  const adminRoutineActions = /* @__PURE__ */ new Set([
    "dashboard.view",
    "users.list",
    "users.inspect",
    "users.set_role",
    "users.set_status",
    "providers.list",
    "providers.inspect",
    "providers.create",
    "providers.update",
    "providers.set_enabled",
    "credentials.list",
    "credentials.create",
    "credentials.set_enabled",
    "policies.list",
    "policies.update",
    "tools.list",
    "audit.list"
  ]);
  if (adminRoutineActions.has(action)) return { ok: true, actor: { userId: actorUserId, role } };
  return { ok: false, kind: "not_authorized" };
}
__name(authorizeAdmin, "authorizeAdmin");

// src/admin/provider-validation.ts
function validateProviderId(id) {
  if (typeof id !== "string" || !/^[a-z0-9-]{1,64}$/.test(id)) {
    throw new AdminError("validation_failed", "Invalid provider id");
  }
}
__name(validateProviderId, "validateProviderId");
function validateBaseUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 512) {
    throw new AdminError("validation_failed", "Invalid base URL");
  }
  if (!url.startsWith("https://")) {
    throw new AdminError("validation_failed", "Base URL must use https");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new AdminError("validation_failed", "Invalid base URL format");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new AdminError("validation_failed", "Base URL must not contain credentials");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new AdminError("validation_failed", "Base URL must not target private networks");
  }
  const bareHost = hostname.replace(/^\[(.+)\]$/, "$1");
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bareHost);
  if (ipv4 !== null) {
    const octets = [
      Number(ipv4[1]),
      Number(ipv4[2]),
      Number(ipv4[3]),
      Number(ipv4[4])
    ];
    if (octets.some((n) => n > 255)) throw new AdminError("validation_failed", "Invalid base URL format");
    if (isPrivateIPv4(octets)) throw new AdminError("validation_failed", "Base URL must not target private networks");
  } else if (bareHost.includes(":")) {
    if (isPrivateIPv6(bareHost)) throw new AdminError("validation_failed", "Base URL must not target private networks");
  }
}
__name(validateBaseUrl, "validateBaseUrl");
function isPrivateIPv4(octets) {
  const [a, b] = [octets[0], octets[1]];
  return a === 0 || a === 10 || a === 127 || // this-network, private, loopback
  a === 169 && b === 254 || // link-local / cloud metadata (169.254.0.0/16)
  a === 172 && b >= 16 && b <= 31 || // private (172.16.0.0/12)
  a === 192 && b === 168 || // private (192.168.0.0/16)
  a === 100 && b >= 64 && b <= 127;
}
__name(isPrivateIPv4, "isPrivateIPv4");
function isPrivateIPv6(hostname) {
  if (hostname.startsWith("::ffff:")) {
    const remainder = hostname.slice("::ffff:".length);
    if (remainder.includes(".")) {
      const parts = remainder.split(".").map(Number);
      return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && isPrivateIPv4(parts);
    }
    const groups = remainder.split(":").filter((g) => g.length > 0);
    if (groups.length === 2) {
      const hex32 = (groups[0] ?? "").padStart(4, "0") + (groups[1] ?? "").padStart(4, "0");
      if (/^[0-9a-f]{8}$/.test(hex32)) {
        const octets = [
          parseInt(hex32.slice(0, 2), 16),
          parseInt(hex32.slice(2, 4), 16),
          parseInt(hex32.slice(4, 6), 16),
          parseInt(hex32.slice(6, 8), 16)
        ];
        return isPrivateIPv4(octets);
      }
    }
    return false;
  }
  if (hostname === "::" || hostname === "::1") return true;
  const firstHextet = /^([0-9a-f]{1,4})/.exec(hostname);
  if (firstHextet !== null && firstHextet[1] !== void 0) {
    const value = parseInt(firstHextet[1], 16);
    if (value >= 64512 && value <= 65023 || value >= 65152 && value <= 65215) return true;
  }
  return false;
}
__name(isPrivateIPv6, "isPrivateIPv6");
function validateDefaultModel(model) {
  if (typeof model !== "string" || model.length === 0 || model.length > 128) {
    throw new AdminError("validation_failed", "Invalid default model");
  }
}
__name(validateDefaultModel, "validateDefaultModel");
function validateWeight(weight) {
  if (!Number.isSafeInteger(weight) || weight < 1 || weight > 1e4) {
    throw new AdminError("validation_failed", "Weight must be an integer between 1 and 10000");
  }
}
__name(validateWeight, "validateWeight");
function validateTimeoutMs(ms) {
  if (!Number.isSafeInteger(ms) || ms < 1e3 || ms > 12e4) {
    throw new AdminError("validation_failed", "Timeout must be between 1000 and 120000 ms");
  }
}
__name(validateTimeoutMs, "validateTimeoutMs");
function validateMaxCredentialAttempts(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 10) {
    throw new AdminError("validation_failed", "Max credential attempts must be between 1 and 10");
  }
}
__name(validateMaxCredentialAttempts, "validateMaxCredentialAttempts");
function validateCredentialLabel(label) {
  if (typeof label !== "string" || label.length === 0 || label.length > 128) {
    throw new AdminError("validation_failed", "Invalid credential label");
  }
  if (!/^[\x20-\x7E]+$/.test(label)) {
    throw new AdminError("validation_failed", "Credential label must be printable ASCII");
  }
}
__name(validateCredentialLabel, "validateCredentialLabel");
function validateCredentialWeight(weight) {
  if (!Number.isSafeInteger(weight) || weight < 1 || weight > 1e4) {
    throw new AdminError("validation_failed", "Credential weight must be an integer between 1 and 10000");
  }
}
__name(validateCredentialWeight, "validateCredentialWeight");

// src/db/admin-providers.ts
async function listAllProviders(db) {
  const result = await db.prepare("SELECT * FROM providers ORDER BY weight DESC, id ASC").all();
  return result.results;
}
__name(listAllProviders, "listAllProviders");
async function findProviderById(db, providerId) {
  const row = await db.prepare("SELECT * FROM providers WHERE id = ?").bind(providerId).first();
  if (row === null) return null;
  return {
    id: String(row["id"]),
    base_url: String(row["base_url"]),
    enabled: Number(row["enabled"]),
    weight: Number(row["weight"]),
    default_model: String(row["default_model"]),
    timeout_ms: Number(row["timeout_ms"]),
    max_credential_attempts: Number(row["max_credential_attempts"]),
    created_at: String(row["created_at"]),
    updated_at: String(row["updated_at"])
  };
}
__name(findProviderById, "findProviderById");
async function listCredentialMetaForProvider(db, providerId) {
  const result = await db.prepare("SELECT id, provider_id, label, enabled, weight, created_at FROM provider_credentials WHERE provider_id = ? ORDER BY weight DESC, id ASC").bind(providerId).all();
  return result.results.map((row) => ({
    id: String(row["id"]),
    providerId: String(row["provider_id"]),
    label: String(row["label"]),
    enabled: Number(row["enabled"]) !== 0,
    weight: Number(row["weight"]),
    created_at: String(row["created_at"])
  }));
}
__name(listCredentialMetaForProvider, "listCredentialMetaForProvider");
async function findCredentialMetaById(db, credentialId) {
  const row = await db.prepare("SELECT id, provider_id, label, enabled, weight, created_at FROM provider_credentials WHERE id = ?").bind(credentialId).first();
  if (row === null) return null;
  return {
    id: String(row["id"]),
    providerId: String(row["provider_id"]),
    label: String(row["label"]),
    enabled: Number(row["enabled"]) !== 0,
    weight: Number(row["weight"]),
    created_at: String(row["created_at"])
  };
}
__name(findCredentialMetaById, "findCredentialMetaById");
async function countProviders(db) {
  const row = await db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(enabled != 0), 0) AS enabled FROM providers").first();
  return { total: row?.total ?? 0, enabled: row?.enabled ?? 0 };
}
__name(countProviders, "countProviders");
async function countCredentials(db) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM provider_credentials").first();
  return row?.count ?? 0;
}
__name(countCredentials, "countCredentials");

// src/db/admin-mutations.ts
function validateMutation(m) {
  if (m.action === "users.set_role" || m.action === "users.set_status") {
    if (!Number.isSafeInteger(m.target) || m.target <= 0) throw new AdminError("validation_failed", "Invalid target");
    if (m.action === "users.set_role" && (!isUserRole(m.expected) || !isUserRole(m.value))) throw new AdminError("validation_failed", "Invalid role");
    if (m.action === "users.set_status" && m.value !== "active" && m.value !== "blocked") throw new AdminError("validation_failed", "Invalid status");
  } else if (m.action === "policies.update") {
    if (!isUserRole(m.target) || m.value === null || typeof m.value !== "object" || Array.isArray(m.value)) throw new AdminError("validation_failed", "Invalid policy");
    const entries = Object.entries(m.value);
    if (entries.length === 0) throw new AdminError("validation_failed", "Empty policy");
    for (const [key, value] of entries) {
      if (key === "bypass_rate" || key === "bypass_quota") {
        if (typeof value !== "boolean") throw new AdminError("validation_failed", "Invalid flag");
      } else if (["daily_messages", "per_second", "per_hour"].includes(key)) {
        if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1e6) throw new AdminError("validation_failed", "Invalid limit");
      } else throw new AdminError("validation_failed", "Unknown field");
    }
  } else if (m.action === "providers.create") {
    if (typeof m.target !== "string" || !/^[a-z0-9-]{1,64}$/.test(m.target)) throw new AdminError("validation_failed", "Invalid identifier");
    const v = m.value;
    if (!v || typeof v !== "object") throw new AdminError("validation_failed", "providers.create requires an object value");
    if (typeof v.id !== "string" || typeof v.baseUrl !== "string" || typeof v.defaultModel !== "string" || typeof v.weight !== "number" || typeof v.timeoutMs !== "number" || typeof v.maxCredentialAttempts !== "number") {
      throw new AdminError("validation_failed", "providers.create value missing required fields");
    }
  } else if (m.action === "providers.update") {
    if (typeof m.target !== "string" || !/^[a-z0-9-]{1,64}$/.test(m.target)) throw new AdminError("validation_failed", "Invalid identifier");
    const v = m.value;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new AdminError("validation_failed", "providers.update requires an object value");
  } else if (m.action === "credentials.create") {
    if (typeof m.target !== "string" || !/^[a-z0-9-]{1,64}$/.test(m.target)) throw new AdminError("validation_failed", "Invalid identifier");
    const v = m.value;
    if (!v || typeof v !== "object") throw new AdminError("validation_failed", "credentials.create requires an object value");
    if (typeof v.id !== "string" || typeof v.providerId !== "string" || typeof v.label !== "string" || typeof v.weight !== "number" || typeof v.sealedCiphertext !== "string") {
      throw new AdminError("validation_failed", "credentials.create value missing required fields");
    }
  } else {
    if (typeof m.target !== "string" || !/^[a-z0-9-]{1,64}$/.test(m.target)) throw new AdminError("validation_failed", "Invalid identifier");
    if (m.action !== "credentials.delete" && typeof m.value !== "boolean") throw new AdminError("validation_failed", "Invalid flag");
  }
}
__name(validateMutation, "validateMutation");
async function applyAdminMutation(db, actorId, m, timestamp, requestId, detail = {}) {
  validateMutation(m);
  const actorGuard = `EXISTS (SELECT 1 FROM users actor WHERE actor.id = ? AND actor.status = 'active' AND actor.role IN ('ADMIN', 'OWNER')`;
  let sql;
  let values;
  let targetType;
  switch (m.action) {
    case "users.set_role":
      targetType = "user";
      sql = `UPDATE users SET role = ?, updated_at = ? WHERE id = ? AND id != ? AND role = ? AND role != ?
        AND ${actorGuard} AND (actor.role = 'OWNER' OR (users.role IN ('USER','VIP') AND ? IN ('USER','VIP'))))
        AND (role != 'OWNER' OR status != 'active' OR ? = 'OWNER' OR (SELECT COUNT(*) FROM users WHERE role = 'OWNER' AND status = 'active') > 1)`;
      values = [m.value, timestamp, m.target, actorId, m.expected, m.value, actorId, m.value, m.value];
      break;
    case "users.set_status":
      targetType = "user";
      sql = `UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND id != ? AND status != ?
        AND ${actorGuard} AND (actor.role = 'OWNER' OR users.role IN ('USER','VIP')))
        AND (role != 'OWNER' OR status != 'active' OR ? = 'active' OR (SELECT COUNT(*) FROM users WHERE role = 'OWNER' AND status = 'active') > 1)`;
      values = [m.value, timestamp, m.target, actorId, m.value, actorId, m.value];
      break;
    case "providers.set_enabled":
    case "credentials.set_enabled": {
      const table = m.action === "providers.set_enabled" ? "providers" : "provider_credentials";
      targetType = m.action === "providers.set_enabled" ? "provider" : "credential";
      sql = `UPDATE ${table} SET enabled = ?, updated_at = ? WHERE id = ? AND enabled != ? AND ${actorGuard})`;
      values = [Number(m.value), timestamp, m.target, Number(m.value), actorId];
      break;
    }
    case "credentials.delete":
      targetType = "credential";
      sql = `DELETE FROM provider_credentials WHERE id = ? AND ${actorGuard} AND actor.role = 'OWNER')`;
      values = [m.target, actorId];
      break;
    case "providers.create": {
      targetType = "provider";
      const p = m.value;
      sql = `INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) SELECT ?, ?, 1, ?, ?, ?, ?, ?, ? WHERE ${actorGuard})`;
      values = [p.id, p.baseUrl, p.weight, p.defaultModel, p.timeoutMs, p.maxCredentialAttempts, timestamp, timestamp, actorId];
      break;
    }
    case "providers.update": {
      targetType = "provider";
      const fields = m.value;
      const setClauses = [];
      const setValues = [];
      if (fields.baseUrl !== void 0) {
        setClauses.push("base_url = ?");
        setValues.push(fields.baseUrl);
      }
      if (fields.defaultModel !== void 0) {
        setClauses.push("default_model = ?");
        setValues.push(fields.defaultModel);
      }
      if (fields.weight !== void 0) {
        setClauses.push("weight = ?");
        setValues.push(fields.weight);
      }
      if (fields.timeoutMs !== void 0) {
        setClauses.push("timeout_ms = ?");
        setValues.push(fields.timeoutMs);
      }
      if (fields.maxCredentialAttempts !== void 0) {
        setClauses.push("max_credential_attempts = ?");
        setValues.push(fields.maxCredentialAttempts);
      }
      if (setClauses.length === 0) throw new AdminError("validation_failed", "No fields to update");
      setClauses.push("updated_at = ?");
      setValues.push(timestamp);
      setValues.push(m.target);
      sql = `UPDATE providers SET ${setClauses.join(", ")} WHERE id = ? AND ${actorGuard})`;
      values = [...setValues, actorId];
      break;
    }
    case "credentials.create": {
      targetType = "credential";
      const c = m.value;
      sql = `INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) SELECT ?, ?, ?, 1, ?, ?, ?, ? WHERE ${actorGuard})`;
      values = [c.id, c.providerId, c.label, c.weight, c.sealedCiphertext, timestamp, timestamp, actorId];
      break;
    }
    case "policies.update": {
      targetType = "policy";
      const entries = Object.entries(m.value);
      const privileged = !["USER", "VIP"].includes(m.target) || entries.some(([key]) => key.startsWith("bypass_"));
      sql = `UPDATE admission_policies SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE role = ? AND ${actorGuard} AND (? = 0 OR actor.role = 'OWNER'))`;
      values = [...entries.map(([, value]) => Number(value)), m.target, actorId, Number(privileged)];
      break;
    }
    default:
      throw new AdminError("validation_failed", "Unknown action");
  }
  let result;
  try {
    result = await db.batch([
      db.prepare(sql).bind(...values),
      db.prepare(`INSERT INTO admin_audit_logs (actor_user_id, actor_role, action, target_type, target_id, success, detail, created_at)
        SELECT id, role, ?, ?, ?, CASE WHEN changes() > 0 THEN 1 ELSE 0 END, ?, ?
        FROM users WHERE id = ? AND role IN ('ADMIN','OWNER')`).bind(m.action, targetType, String(m.target), JSON.stringify({ ...detail, request_id: requestId?.slice(0, 128) ?? null }), timestamp, actorId)
    ]);
  } catch {
    throw new AdminError("storage_failed", "Administrative change unavailable");
  }
  if ((result[0]?.meta.changes ?? 0) === 0) throw new AdminError("conflict", "Change not applied");
}
__name(applyAdminMutation, "applyAdminMutation");

// src/db/admin-policies.ts
function toPolicy(row) {
  const role = row["role"];
  return {
    role: isUserRole(role) ? role : "USER",
    daily_messages: Number(row["daily_messages"]),
    per_second: Number(row["per_second"]),
    per_hour: Number(row["per_hour"]),
    bypass_quota: Number(row["bypass_quota"]) !== 0,
    bypass_rate: Number(row["bypass_rate"]) !== 0
  };
}
__name(toPolicy, "toPolicy");
async function listPolicies(db) {
  const result = await db.prepare(`SELECT * FROM admission_policies ORDER BY CASE role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 WHEN 'VIP' THEN 2 WHEN 'USER' THEN 3 ELSE 4 END`).all();
  return result.results.map(toPolicy);
}
__name(listPolicies, "listPolicies");
async function findPolicy(db, role) {
  const row = await db.prepare("SELECT * FROM admission_policies WHERE role = ?").bind(role).first();
  return row === null ? null : toPolicy(row);
}
__name(findPolicy, "findPolicy");

// src/db/admin-audit.ts
var MAX_AUDIT_ACTION_CHARS = 64;
var MAX_AUDIT_TARGET_TYPE_CHARS = 32;
var MAX_AUDIT_TARGET_ID_CHARS = 128;
var MAX_AUDIT_DETAIL_CHARS = 2e3;
function bounded(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}
__name(bounded, "bounded");
async function appendAuditLog(db, entry) {
  await db.prepare("INSERT INTO admin_audit_logs (actor_user_id, actor_role, action, target_type, target_id, success, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
    entry.actorUserId,
    entry.actorRole,
    bounded(entry.action, MAX_AUDIT_ACTION_CHARS),
    bounded(entry.targetType, MAX_AUDIT_TARGET_TYPE_CHARS),
    entry.targetId === null ? null : bounded(entry.targetId, MAX_AUDIT_TARGET_ID_CHARS),
    entry.success ? 1 : 0,
    bounded(entry.detail, MAX_AUDIT_DETAIL_CHARS) || "{}",
    entry.createdAt
  ).run();
}
__name(appendAuditLog, "appendAuditLog");
async function listAuditPage(db, beforeId, pageSize) {
  const size = Math.min(Math.max(1, Math.floor(pageSize)), 20);
  const result = beforeId === null ? await db.prepare("SELECT * FROM admin_audit_logs ORDER BY id DESC LIMIT ?").bind(size + 1).all() : await db.prepare("SELECT * FROM admin_audit_logs WHERE id < ? ORDER BY id DESC LIMIT ?").bind(beforeId, size + 1).all();
  const hasMore = result.results.length > size;
  const records = result.results.slice(0, size).map((row) => ({
    id: Number(row["id"]),
    actorUserId: Number(row["actor_user_id"]),
    actorRole: String(row["actor_role"]),
    action: String(row["action"]),
    targetType: String(row["target_type"]),
    targetId: row["target_id"] === null || row["target_id"] === void 0 ? null : String(row["target_id"]),
    success: Number(row["success"]) !== 0,
    detail: String(row["detail"]),
    createdAt: String(row["created_at"])
  }));
  const last = records.at(-1);
  return { records, nextCursor: hasMore && last !== void 0 ? last.id : null };
}
__name(listAuditPage, "listAuditPage");

// src/db/admin-confirmations.ts
async function createAdminConfirmation(db, input) {
  await db.prepare("DELETE FROM admin_confirmations WHERE actor_user_id = ? AND expires_at <= ?").bind(input.actorUserId, input.createdAt).run();
  await db.prepare(
    "INSERT INTO admin_confirmations (id, actor_user_id, action, target_type, target_id, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(input.id, input.actorUserId, input.action, input.targetType, input.targetId, input.payload, input.createdAt, input.expiresAt).run();
}
__name(createAdminConfirmation, "createAdminConfirmation");
async function findAdminConfirmation(db, id) {
  const row = await db.prepare("SELECT * FROM admin_confirmations WHERE id = ?").bind(id).first();
  if (row === null) return null;
  return {
    id: String(row["id"]),
    actor_user_id: Number(row["actor_user_id"]),
    action: String(row["action"]),
    target_type: String(row["target_type"]),
    target_id: String(row["target_id"]),
    payload: String(row["payload"]),
    created_at: String(row["created_at"]),
    expires_at: String(row["expires_at"]),
    used_at: typeof row["used_at"] === "string" ? String(row["used_at"]) : null
  };
}
__name(findAdminConfirmation, "findAdminConfirmation");
async function consumeAdminConfirmation(db, id, now) {
  const result = await db.prepare("UPDATE admin_confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").bind(now, id, now).run();
  return (result.meta.changes ?? 0) > 0;
}
__name(consumeAdminConfirmation, "consumeAdminConfirmation");

// src/admin/service.ts
var CONFIRMATION_TTL_MS = 10 * 60 * 1e3;
function newConfirmationId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(newConfirmationId, "newConfirmationId");
var AdminService = class {
  static {
    __name(this, "AdminService");
  }
  db;
  now;
  sealFn;
  constructor(db, now, sealFn) {
    this.db = db;
    this.now = now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
    this.sealFn = sealFn;
  }
  async authorize(actorUserId, action) {
    const auth = await authorizeAdmin(this.db, actorUserId, action);
    if (!auth.ok || auth.actor === void 0) throw new AdminError(auth.kind ?? "not_authorized", "Admin action denied");
    return auth.actor;
  }
  async audit(actor, action, targetType, targetId, success, detail = {}, ctx) {
    const withRequest = ctx?.requestId !== void 0 ? { ...detail, request_id: ctx.requestId } : detail;
    await appendAuditLog(this.db, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action,
      targetType,
      targetId,
      success,
      detail: JSON.stringify(withRequest),
      createdAt: this.now()
    }).catch(() => {
      throw new AdminError("storage_failed", "Audit unavailable");
    });
  }
  has(actorRole, capability) {
    return capabilitiesFor(actorRole).includes(capability);
  }
  // --- dashboard ---------------------------------------------------------------
  async getDashboard(actorUserId) {
    await this.authorize(actorUserId, "dashboard.view");
    try {
      const [totalUsers, usersByRole, providers, credentialCount, recentAudit] = await Promise.all([
        countUsers(this.db),
        countUsersByRole(this.db),
        countProviders(this.db),
        countCredentials(this.db),
        listAuditPage(this.db, null, 5)
      ]);
      return { totalUsers, usersByRole, providers, credentialCount, recentAudit: recentAudit.records };
    } catch {
      throw new AdminError("storage_failed", "Dashboard metrics unavailable");
    }
  }
  // --- users --------------------------------------------------------------------
  async listUsers(actorUserId, cursor) {
    await this.authorize(actorUserId, "users.list");
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new AdminError("validation_failed", "Invalid cursor");
    try {
      return await listUsersPage(this.db, cursor, 10);
    } catch {
      throw new AdminError("storage_failed", "User list unavailable");
    }
  }
  async inspectUser(actorUserId, targetUserId) {
    await this.authorize(actorUserId, "users.inspect");
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) throw new AdminError("validation_failed", "Invalid user id");
    const target = await findUserById(this.db, targetUserId).catch(() => {
      throw new AdminError("storage_failed", "Administrative data unavailable");
    });
    if (target === null) throw new AdminError("not_found", "User not found");
    return target;
  }
  async setUserRole(actorUserId, targetUserId, expectedRole, nextRole, ctx) {
    await this.precheckSetRole(actorUserId, targetUserId, expectedRole, nextRole, ctx);
    await applyAdminMutation(this.db, actorUserId, { action: "users.set_role", target: targetUserId, expected: expectedRole, value: nextRole }, this.now(), ctx?.requestId);
  }
  /**
   * Full authorization + validation pre-check for role changes, WITHOUT any
   * mutation. Shared by setUserRole and the destructive-confirmation request
   * flow so both paths enforce identical rules (ceiling, privileged targets,
   * self-protection, last-owner guard) and audit their denials identically.
   */
  async precheckSetRole(actorUserId, targetUserId, expectedRole, nextRole, ctx) {
    const actor = await this.authorize(actorUserId, "users.set_role");
    validateMutation({ action: "users.set_role", target: targetUserId, expected: expectedRole, value: nextRole });
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) throw new AdminError("validation_failed", "Invalid user id");
    if (targetUserId === actor.userId) {
      await this.audit(actor, "users.set_role", "user", String(targetUserId), false, { reason: "self_change" }, ctx);
      throw new AdminError("validation_failed", "You cannot change your own role.");
    }
    const assignable = actor.role === "OWNER" || nextRole === "USER" || nextRole === "VIP";
    if (!assignable) {
      await this.audit(actor, "users.set_role", "user", String(targetUserId), false, { reason: "role_not_assignable", next_role: nextRole }, ctx);
      throw new AdminError("not_authorized", "You cannot assign that role.");
    }
    const target = await findUserById(this.db, targetUserId).catch(() => {
      throw new AdminError("storage_failed", "Administrative data unavailable");
    });
    if (target === null) throw new AdminError("not_found", "User not found");
    if (target.role !== expectedRole) throw new AdminError("conflict", "User changed; reload.");
    if (isPrivilegedTarget(target.role) && !this.has(actor.role, "manage_privileged_users")) {
      await this.audit(actor, "users.set_role", "user", String(targetUserId), false, { reason: "target_privileged", target_role: target.role }, ctx);
      throw new AdminError("not_authorized", "Owner authorization required for that target.");
    }
    if (target.role === "OWNER" && target.status === "active" && nextRole !== "OWNER" && await countOwners(this.db) <= 1) {
      await this.audit(actor, "user_demote_last_owner", "user", String(targetUserId), false, {}, ctx);
      throw new AdminError("conflict", "Cannot demote the last active owner.");
    }
    return { actor, target };
  }
  async setUserStatus(actorUserId, targetUserId, nextStatus, ctx) {
    await this.precheckSetStatus(actorUserId, targetUserId, nextStatus, ctx);
    await applyAdminMutation(this.db, actorUserId, { action: "users.set_status", target: targetUserId, value: nextStatus }, this.now(), ctx?.requestId);
  }
  /** Authorization + validation pre-check for status changes, without mutation. */
  async precheckSetStatus(actorUserId, targetUserId, nextStatus, ctx) {
    const actor = await this.authorize(actorUserId, "users.set_status");
    if (nextStatus !== "active" && nextStatus !== "blocked") throw new AdminError("validation_failed", "Invalid status");
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) throw new AdminError("validation_failed", "Invalid user id");
    if (targetUserId === actor.userId) {
      await this.audit(actor, "users.set_status", "user", String(targetUserId), false, { reason: "self_change" }, ctx);
      throw new AdminError("validation_failed", "You cannot change your own status.");
    }
    const target = await findUserById(this.db, targetUserId).catch(() => {
      throw new AdminError("storage_failed", "Administrative data unavailable");
    });
    if (target === null) throw new AdminError("not_found", "User not found");
    if (isPrivilegedTarget(target.role) && !this.has(actor.role, "manage_privileged_users")) {
      await this.audit(actor, "users.set_status", "user", String(targetUserId), false, { reason: "target_privileged", target_role: target.role }, ctx);
      throw new AdminError("not_authorized", "Owner authorization required for that target.");
    }
    return { actor, target };
  }
  // --- providers / credentials -----------------------------------------------------
  async listProviders(actorUserId) {
    await this.authorize(actorUserId, "providers.list");
    try {
      const providers = await listAllProviders(this.db);
      return await Promise.all(providers.map(async (provider) => ({
        id: provider.id,
        enabled: provider.enabled !== 0,
        weight: provider.weight,
        defaultModel: provider.default_model,
        credentialCount: (await listCredentialMetaForProvider(this.db, provider.id)).length
      })));
    } catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError("storage_failed", "Provider list unavailable");
    }
  }
  async inspectProvider(actorUserId, providerId) {
    await this.authorize(actorUserId, "providers.inspect");
    if (!/^[a-z0-9-]{1,64}$/.test(providerId)) throw new AdminError("validation_failed", "Invalid provider id");
    const provider = await findProviderById(this.db, providerId).catch(() => {
      throw new AdminError("storage_failed", "Administrative data unavailable");
    });
    if (provider === null) throw new AdminError("not_found", "Provider not found");
    const credentials = await listCredentialMetaForProvider(this.db, providerId).catch(() => {
      throw new AdminError("storage_failed", "Credential metadata unavailable");
    });
    return {
      id: provider.id,
      baseUrl: provider.base_url,
      enabled: provider.enabled !== 0,
      weight: provider.weight,
      defaultModel: provider.default_model,
      timeoutMs: provider.timeout_ms,
      maxCredentialAttempts: provider.max_credential_attempts,
      credentials: credentials.map((credential) => ({ id: credential.id, label: credential.label, enabled: credential.enabled, weight: credential.weight }))
    };
  }
  async createProvider(actorUserId, params, ctx) {
    await this.authorize(actorUserId, "providers.create");
    validateProviderId(params.id);
    validateBaseUrl(params.baseUrl);
    validateDefaultModel(params.defaultModel);
    const weight = params.weight ?? 100;
    const timeoutMs = params.timeoutMs ?? 3e4;
    const maxCredentialAttempts = params.maxCredentialAttempts ?? 3;
    validateWeight(weight);
    validateTimeoutMs(timeoutMs);
    validateMaxCredentialAttempts(maxCredentialAttempts);
    const existing = await findProviderById(this.db, params.id).catch(() => {
      throw new AdminError("storage_failed", "Administrative data unavailable");
    });
    if (existing !== null) throw new AdminError("conflict", "Provider already exists");
    const insertParams = { id: params.id, baseUrl: params.baseUrl, defaultModel: params.defaultModel, weight, timeoutMs, maxCredentialAttempts };
    await applyAdminMutation(this.db, actorUserId, { action: "providers.create", target: params.id, value: insertParams }, this.now(), ctx?.requestId, {
      base_url: params.baseUrl,
      default_model: params.defaultModel,
      weight,
      timeout_ms: timeoutMs
    });
  }
  async updateProvider(actorUserId, providerId, fields, ctx) {
    await this.authorize(actorUserId, "providers.update");
    validateProviderId(providerId);
    if (Object.keys(fields).length === 0) throw new AdminError("validation_failed", "No fields to update");
    if (fields.baseUrl !== void 0) validateBaseUrl(fields.baseUrl);
    if (fields.defaultModel !== void 0) validateDefaultModel(fields.defaultModel);
    if (fields.weight !== void 0) validateWeight(fields.weight);
    if (fields.timeoutMs !== void 0) validateTimeoutMs(fields.timeoutMs);
    if (fields.maxCredentialAttempts !== void 0) validateMaxCredentialAttempts(fields.maxCredentialAttempts);
    const existing = await findProviderById(this.db, providerId).catch(() => {
      throw new AdminError("storage_failed", "Administrative data unavailable");
    });
    if (existing === null) throw new AdminError("not_found", "Provider not found");
    const updateFields = {};
    if (fields.baseUrl !== void 0) updateFields.baseUrl = fields.baseUrl;
    if (fields.defaultModel !== void 0) updateFields.defaultModel = fields.defaultModel;
    if (fields.weight !== void 0) updateFields.weight = fields.weight;
    if (fields.timeoutMs !== void 0) updateFields.timeoutMs = fields.timeoutMs;
    if (fields.maxCredentialAttempts !== void 0) updateFields.maxCredentialAttempts = fields.maxCredentialAttempts;
    await applyAdminMutation(this.db, actorUserId, { action: "providers.update", target: providerId, value: updateFields }, this.now(), ctx?.requestId, {
      fields: Object.keys(fields)
    });
  }
  async createCredential(actorUserId, params, ctx) {
    await this.authorize(actorUserId, "credentials.create");
    validateProviderId(params.providerId);
    validateCredentialLabel(params.label);
    const weight = params.weight ?? 100;
    validateCredentialWeight(weight);
    if (typeof params.plaintextKey !== "string" || params.plaintextKey.length === 0) {
      throw new AdminError("validation_failed", "Plaintext key must not be empty");
    }
    if (!this.sealFn) {
      throw new AdminError("storage_failed", "Credential encryption is not configured");
    }
    const existing = await findProviderById(this.db, params.providerId).catch(() => {
      throw new AdminError("storage_failed", "Administrative data unavailable");
    });
    if (existing === null) throw new AdminError("not_found", "Provider not found");
    let sealed;
    try {
      sealed = await this.sealFn(params.plaintextKey);
    } catch {
      throw new AdminError("storage_failed", "Credential encryption failed");
    }
    const credId = `${params.providerId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const insertParams = { id: credId, providerId: params.providerId, label: params.label, weight, sealedCiphertext: sealed };
    await applyAdminMutation(this.db, actorUserId, { action: "credentials.create", target: credId, value: insertParams }, this.now(), ctx?.requestId, {
      provider_id: params.providerId,
      label: params.label,
      weight
    });
  }
  /** Credential metadata lookup (never ciphertext), authorized as credentials.list. */
  async inspectCredential(actorUserId, credentialId) {
    await this.authorize(actorUserId, "credentials.list");
    if (!/^[a-z0-9-]{1,64}$/.test(credentialId)) throw new AdminError("validation_failed", "Invalid credential id");
    const meta = await findCredentialMetaById(this.db, credentialId).catch(() => {
      throw new AdminError("storage_failed", "Administrative data unavailable");
    });
    if (meta === null) throw new AdminError("not_found", "Credential not found");
    return meta;
  }
  async setProviderEnabled(actorUserId, providerId, enabled, ctx) {
    const actor = await this.authorize(actorUserId, "providers.set_enabled");
    if (!/^[a-z0-9-]{1,64}$/.test(providerId)) throw new AdminError("validation_failed", "Invalid provider id");
    await applyAdminMutation(this.db, actor.userId, { action: "providers.set_enabled", target: providerId, value: enabled }, this.now(), ctx?.requestId);
  }
  async setCredentialEnabled(actorUserId, credentialId, enabled, ctx) {
    const actor = await this.authorize(actorUserId, "credentials.set_enabled");
    if (!/^[a-z0-9-]{1,64}$/.test(credentialId)) throw new AdminError("validation_failed", "Invalid credential id");
    await applyAdminMutation(this.db, actor.userId, { action: "credentials.set_enabled", target: credentialId, value: enabled }, this.now(), ctx?.requestId);
  }
  async deleteCredential(actorUserId, credentialId, ctx) {
    await this.precheckDeleteCredential(actorUserId, credentialId);
    await applyAdminMutation(this.db, actorUserId, { action: "credentials.delete", target: credentialId }, this.now(), ctx?.requestId);
  }
  /** Authorization + validation pre-check for credential deletion, without mutation. */
  async precheckDeleteCredential(actorUserId, credentialId) {
    await this.authorize(actorUserId, "credentials.delete");
    if (!/^[a-z0-9-]{1,64}$/.test(credentialId)) throw new AdminError("validation_failed", "Invalid credential id");
    const credential = await findCredentialMetaById(this.db, credentialId).catch(() => {
      throw new AdminError("storage_failed", "Administrative data unavailable");
    });
    if (credential === null) throw new AdminError("not_found", "Credential not found");
  }
  // --- destructive-action confirmation (durable, single-use, fail-closed) -----
  /**
   * Runs every authorization/validation pre-check for a destructive intent
   * WITHOUT mutating, then stores a durable D1 confirmation row binding
   * actor + action + target. Returns the confirmation id for the UI.
   */
  async requestDestructiveConfirmation(actorUserId, intent, ctx) {
    let targetType;
    let targetId;
    let payload;
    let destructive;
    switch (intent.action) {
      case "credentials.delete":
        await this.precheckDeleteCredential(actorUserId, intent.credentialId);
        targetType = "credential";
        targetId = intent.credentialId;
        payload = {};
        destructive = true;
        break;
      case "users.set_role": {
        const { target } = await this.precheckSetRole(actorUserId, intent.userId, intent.expectedRole, intent.nextRole, ctx);
        targetType = "user";
        targetId = String(intent.userId);
        payload = { expected_role: intent.expectedRole, next_role: intent.nextRole };
        destructive = isPrivilegedTarget(target.role) || intent.nextRole === "ADMIN" || intent.nextRole === "OWNER";
        break;
      }
      case "users.set_status": {
        const { target } = await this.precheckSetStatus(actorUserId, intent.userId, intent.nextStatus, ctx);
        targetType = "user";
        targetId = String(intent.userId);
        payload = { next_status: intent.nextStatus };
        destructive = intent.nextStatus === "blocked" && isPrivilegedTarget(target.role);
        break;
      }
      default: {
        const exhaustive = intent;
        throw new AdminError("validation_failed", `Unsupported intent: ${String(exhaustive.action)}`);
      }
    }
    if (!destructive) throw new AdminError("validation_failed", "This action does not require confirmation.");
    const now = this.now();
    const base = Date.parse(now);
    const confirmationId = newConfirmationId();
    const expiresAt = Number.isFinite(base) ? new Date(base + CONFIRMATION_TTL_MS).toISOString() : now;
    await createAdminConfirmation(this.db, {
      id: confirmationId,
      actorUserId,
      action: intent.action,
      targetType,
      targetId,
      payload: JSON.stringify(payload),
      createdAt: now,
      expiresAt
    }).catch(() => {
      throw new AdminError("storage_failed", "Confirmation unavailable");
    });
    return { confirmationId, action: intent.action, targetType, targetId };
  }
  /**
   * Reads a pending confirmation for display. Fails closed: the row must
   * belong to the caller, be unconsumed, and be unexpired.
   */
  async describeConfirmation(actorUserId, confirmationId) {
    if (!/^[a-f0-9]{32}$/.test(confirmationId)) throw new AdminError("validation_failed", "Invalid confirmation");
    const row = await findAdminConfirmation(this.db, confirmationId).catch(() => {
      throw new AdminError("storage_failed", "Confirmation unavailable");
    });
    if (row === null) throw new AdminError("not_found", "Confirmation not found or expired.");
    if (row.actor_user_id !== actorUserId) throw new AdminError("not_authorized", "Confirmation does not belong to you.");
    if (row.used_at !== null || row.expires_at <= this.now()) throw new AdminError("conflict", "Confirmation expired or already used.");
    return { confirmationId: row.id, action: row.action, targetType: row.target_type, targetId: row.target_id };
  }
  /**
   * Executes a confirmed destructive action. The confirmation is consumed
   * atomically FIRST (single-use, exactly-once semantics; a later failure
   * only wastes the confirmation, never replays the mutation), then the
   * underlying AdminService method re-runs full authorization and performs
   * the audited, atomic mutation.
   */
  async executeConfirmed(actorUserId, confirmationId, ctx) {
    if (!/^[a-f0-9]{32}$/.test(confirmationId)) throw new AdminError("validation_failed", "Invalid confirmation");
    const row = await findAdminConfirmation(this.db, confirmationId).catch(() => {
      throw new AdminError("storage_failed", "Confirmation unavailable");
    });
    if (row === null) throw new AdminError("not_found", "Confirmation not found or expired.");
    if (row.actor_user_id !== actorUserId) throw new AdminError("not_authorized", "Confirmation does not belong to you.");
    if (row.used_at !== null) throw new AdminError("conflict", "Confirmation already used.");
    if (row.expires_at <= this.now()) throw new AdminError("conflict", "Confirmation expired.");
    const consumed = await consumeAdminConfirmation(this.db, confirmationId, this.now()).catch(() => {
      throw new AdminError("storage_failed", "Confirmation unavailable");
    });
    if (!consumed) throw new AdminError("conflict", "Confirmation already used or expired.");
    const params = JSON.parse(row.payload);
    switch (row.action) {
      case "credentials.delete":
        await this.deleteCredential(actorUserId, String(params["credentialId"] ?? row.target_id), ctx);
        return { action: "credentials.delete", targetType: "credential", targetId: row.target_id };
      case "users.set_role":
        await this.setUserRole(actorUserId, Number(params["userId"] ?? row.target_id), params["expected_role"], params["next_role"], ctx);
        return { action: "users.set_role", targetType: "user", targetId: row.target_id };
      case "users.set_status":
        await this.setUserStatus(actorUserId, Number(params["userId"] ?? row.target_id), "blocked", ctx);
        return { action: "users.set_status", targetType: "user", targetId: row.target_id };
      default:
        throw new AdminError("conflict", "Unknown confirmation action.");
    }
  }
  /**
   * Explicit CMS base-access gate: the Telegram layer calls this before
   * rendering any admin surface. Returns the verified actor on success.
   */
  async checkAccess(actorUserId) {
    return this.authorize(actorUserId, "dashboard.view");
  }
  // --- admission policies ------------------------------------------------------------
  async listPolicies(actorUserId) {
    await this.authorize(actorUserId, "policies.list");
    const rows = await listPolicies(this.db).catch(() => {
      throw new AdminError("storage_failed", "Administrative data unavailable");
    });
    if (rows === null) throw new AdminError("storage_failed", "Policy list unavailable");
    return rows.map((row) => ({
      role: row.role,
      dailyMessages: row.daily_messages,
      perSecond: row.per_second,
      perHour: row.per_hour,
      bypassQuota: row.bypass_quota,
      bypassRate: row.bypass_rate
    }));
  }
  async updatePolicy(actorUserId, role, update, ctx) {
    const actor = await this.authorize(actorUserId, "policies.update");
    if (Object.keys(update).length === 0) throw new AdminError("validation_failed", "No policy fields given");
    const touchesPrivileged = role === "OWNER" || role === "ADMIN" || role === "BLOCKED" || update.bypass_quota !== void 0 || update.bypass_rate !== void 0;
    if (touchesPrivileged && !this.has(actor.role, "edit_privileged_policies")) {
      await this.audit(actor, "policies.update", "policy", String(role), false, { reason: "privileged_field" }, ctx);
      throw new AdminError("not_authorized", "Owner authorization required for that policy field.");
    }
    const existing = await findPolicy(this.db, role).catch(() => {
      throw new AdminError("storage_failed", "Administrative data unavailable");
    });
    if (existing === null) throw new AdminError("not_found", "Policy not found");
    await applyAdminMutation(this.db, actor.userId, { action: "policies.update", target: role, value: update }, this.now(), ctx?.requestId);
  }
  // --- usage analytics (Phase 10, OWNER-only visibility) -------------------------
  async getUsageSummary(actorUserId) {
    await this.authorize(actorUserId, "usage.view");
    return summarizeAllUsage(this.db).catch(() => {
      throw new AdminError("storage_failed", "Usage data unavailable");
    });
  }
  async setModelPrice(actorUserId, providerId, vendorModel, inputPerMtok, outputPerMtok, ctx) {
    const actor = await this.authorize(actorUserId, "prices.edit");
    if (!/^[a-z0-9-]{1,64}$/.test(providerId)) throw new AdminError("validation_failed", "Invalid provider id");
    if (typeof vendorModel !== "string" || vendorModel.length === 0 || vendorModel.length > 128) {
      throw new AdminError("validation_failed", "Invalid model name");
    }
    for (const value of [inputPerMtok, outputPerMtok]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 9007199254740991) throw new AdminError("validation_failed", "Invalid price");
    }
    await setProviderPrice(this.db, providerId, vendorModel, inputPerMtok, outputPerMtok, this.now()).catch(() => {
      throw new AdminError("storage_failed", "Price update unavailable");
    });
    await this.audit(actor, "prices.edit", "price", `${providerId}:${vendorModel}`, true, {}, ctx);
  }
  // --- tools / audit -------------------------------------------------------------------
  async listTools(actorUserId, registryNames) {
    await this.authorize(actorUserId, "tools.list");
    return registryNames.filter((name) => typeof name === "string" && /^[a-z][a-z0-9_]*$/.test(name) && name.length <= 64).slice(0, 20);
  }
  async getRoutingProfiles(actorUserId) {
    await this.authorize(actorUserId, "providers.list");
    return ["FAST", "DEFAULT", "COMPLEX", "RESEARCH"].map((profile) => ({
      profile,
      label: ROUTING_PROFILE_INFO[profile].label,
      description: ROUTING_PROFILE_INFO[profile].description
    }));
  }
  async listAudit(actorUserId, cursor) {
    await this.authorize(actorUserId, "audit.list");
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new AdminError("validation_failed", "Invalid cursor");
    try {
      return await listAuditPage(this.db, cursor, 10);
    } catch {
      throw new AdminError("storage_failed", "Audit list unavailable");
    }
  }
};

// src/router/index.ts
function productionFlow(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") return void 0;
  const provider = buildProductionProvider(env.DB, env);
  if (provider === null) return void 0;
  const db = env.DB;
  const directorySnapshot = new D1ProviderDirectorySnapshot(new D1ProviderDirectory(db));
  const researchTools = buildProductionResearchTools();
  return (requestId, internalUserId) => {
    const deps = {
      orchestrator: new D1ConversationOrchestrator(db, new D1ConversationRepository(db)),
      processing: new D1ProcessingRepository(db),
      admission: new D1AdmissionGate(db),
      provider,
      requestId,
      agentUserId: String(internalUserId),
      userId: internalUserId,
      model: "router",
      systemPrompt: "",
      directorySnapshot,
      usageRecorder: buildProductionUsageRecorder(db, internalUserId, requestId, () => (/* @__PURE__ */ new Date()).toISOString()),
      researchTools
    };
    const recall = buildProductionMemoryRecall(env, internalUserId);
    if (recall !== void 0) deps.memoryRecall = recall;
    return deps;
  };
}
__name(productionFlow, "productionFlow");
async function route(request, ctx) {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/healthz") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "GET, HEAD" } }
      );
    }
    return Response.json({ status: "ok" });
  }
  if (pathname === TELEGRAM_WEBHOOK_PATH) {
    if (!ctx) {
      return Response.json({ error: "Something went wrong" }, { status: 500 });
    }
    const sealFn = ctx.env.CREDENTIAL_MASTER_SECRET ? ((plaintext) => sealCredential(plaintext, ctx.env.CREDENTIAL_MASTER_SECRET)) : void 0;
    const adminService = ctx.adminService ?? (ctx.env.DB && typeof ctx.env.DB.prepare === "function" ? new AdminService(ctx.env.DB, ctx.now, sealFn) : void 0);
    return handleTelegramWebhook(request, ctx.env, ctx.requestId, {
      fetchImpl: ctx.telegramFetch,
      now: ctx.now,
      flow: ctx.flow ?? productionFlow(ctx.env),
      adminService
    });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}
__name(route, "route");

// src/index.ts
var index_default = {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    let response;
    try {
      validateEnv(env);
      response = await route(request, { env, requestId });
    } catch {
      console.error(JSON.stringify({ event: "request_failed", request_id: requestId }));
      response = Response.json({ error: "Something went wrong" }, { status: 500 });
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Request-ID", requestId);
    if (request.method === "HEAD") {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
