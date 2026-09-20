import { D1AdmissionGate } from '../db/admission-d1';
import type { AppEnv } from '../env';
import { handleTelegramWebhook, TELEGRAM_WEBHOOK_PATH } from '../telegram/webhook';
import type { ConversationFlowFactory } from '../telegram/webhook';
import { D1ConversationOrchestrator } from '../orchestration/conversation-orchestrator';
import { D1ProcessingRepository } from '../orchestration/processing-d1';
import { D1ConversationRepository } from '../db/conversation-d1';
import { buildProductionProvider, buildProductionResearchTools, buildProductionUsageRecorder, D1ProviderDirectorySnapshot, buildProductionMemoryRecall } from '../orchestration/production';
import { withHawkTalkIdentity } from '../orchestration/identity';
import { MAX_SYSTEM_PROMPT_CHARS } from '../agent/types';
import { D1ProviderDirectory } from '../ai/router';
import type { ConversationFlowDeps } from '../orchestration/service';
import { AdminService } from '../admin/service';
import { sealCredential } from '../ai/crypto';

/**
 * Production conversational flow factory (composition root). Wires D1
 * persistence, the default-conversation orchestrator, and the AI Router.
 * Returns null when the environment cannot support conversation (no master
 * secret), which leaves the webhook in transport-only mode.
 */
export function productionFlow(env: Partial<AppEnv>): ConversationFlowFactory | undefined {
  if (!env.DB || typeof env.DB.prepare !== 'function') return undefined;
  const provider = buildProductionProvider(env.DB, env);
  if (provider === null) return undefined;
  const db = env.DB;
  // Phase 10: the flow carries the production directory snapshot (non-secret
  // routing metadata for profile resolution), a per-request usage recorder,
  // and the read-only research tools. Each factory invocation binds them to
  // its own user/request; nothing is shared across users.
  const directorySnapshot = new D1ProviderDirectorySnapshot(new D1ProviderDirectory(db));
  const researchTools = buildProductionResearchTools();
  return (requestId: string, internalUserId: number): ConversationFlowDeps => {
    const deps: ConversationFlowDeps = {
      orchestrator: new D1ConversationOrchestrator(db, new D1ConversationRepository(db)),
      processing: new D1ProcessingRepository(db),
      admission: new D1AdmissionGate(db),
      provider,
      requestId,
      agentUserId: String(internalUserId),
      userId: internalUserId,
      model: 'router',
      // Stable HawkTalk assistant identity + security policy (provider-
      // agnostic; survives failover). Previously an empty string, which let
      // the underlying model self-identify in conversation.
      systemPrompt: withHawkTalkIdentity('', MAX_SYSTEM_PROMPT_CHARS),
      directorySnapshot,
      usageRecorder: buildProductionUsageRecorder(db, internalUserId, requestId, () => new Date().toISOString()),
      researchTools,
    };
    const recall = buildProductionMemoryRecall(env, internalUserId);
    if (recall !== undefined) deps.memoryRecall = recall;
    return deps;
  };
}

export interface RouteContext {
  env: Partial<AppEnv>;
  /** Correlates webhook logs with the entrypoint's X-Request-ID. */
  requestId: string;
  telegramFetch?: typeof fetch;
  now?: () => string;
  /** Conversational flow factory (Phase 6); production composes D1 + AI Router. */
  flow?: ConversationFlowFactory;
  /**
   * Background execution (Cloudflare waitUntil). When provided, the Telegram
   * webhook acknowledges Telegram immediately after the durable claim and the
   * conversational flow continues under waitUntil; when absent the flow runs
   * synchronously (legacy behavior, used by tests and non-worker callers).
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Phase 9 admin CMS. Production composes it from D1 when available. */
  adminService?: AdminService;
}

export async function route(request: Request, ctx?: RouteContext): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/healthz') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, HEAD' } },
      );
    }
    return Response.json({ status: 'ok' });
  }
  if (pathname === TELEGRAM_WEBHOOK_PATH) {
    // Fail closed when the route is invoked without an environment (webhook
    // auth and D1 both require it); the handler owns all further validation.
    if (!ctx) {
      return Response.json({ error: 'Something went wrong' }, { status: 500 });
    }
    // The request ID comes from the entrypoint (which also returns it as
    // X-Request-ID), so webhook logs correlate with the response header.
    // It is used for log correlation only, never trusted from the caller.
    // The admin CMS is composed from D1 when available (no secrets needed);
    // tests may inject their own instance.
    const sealFn = ctx.env.CREDENTIAL_MASTER_SECRET
      ? ((plaintext: string) => sealCredential(plaintext, ctx.env.CREDENTIAL_MASTER_SECRET!))
      : undefined;
    const adminService = ctx.adminService ?? (ctx.env.DB && typeof ctx.env.DB.prepare === 'function' ? new AdminService(ctx.env.DB, ctx.now, sealFn) : undefined);
    return handleTelegramWebhook(request, ctx.env, ctx.requestId, {
      fetchImpl: ctx.telegramFetch,
      now: ctx.now,
      flow: ctx.flow ?? productionFlow(ctx.env),
      adminService,
      waitUntil: ctx.waitUntil,
    });
  }
  return Response.json({ error: 'Not found' }, { status: 404 });
}
