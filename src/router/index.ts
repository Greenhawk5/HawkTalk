import { D1AdmissionGate } from '../db/admission-d1';
import type { AppEnv } from '../env';
import { handleTelegramWebhook, TELEGRAM_WEBHOOK_PATH } from '../telegram/webhook';
import type { ConversationFlowFactory } from '../telegram/webhook';
import { D1ConversationOrchestrator } from '../orchestration/conversation-orchestrator';
import { D1ProcessingRepository } from '../orchestration/processing-d1';
import { D1ConversationRepository } from '../db/conversation-d1';
import { buildProductionProvider } from '../orchestration/production';
import type { ConversationFlowDeps } from '../orchestration/service';

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
  return (requestId: string, internalUserId: number): ConversationFlowDeps => ({
    orchestrator: new D1ConversationOrchestrator(db, new D1ConversationRepository(db)),
    processing: new D1ProcessingRepository(db),
    admission: new D1AdmissionGate(db),
    provider,
    requestId,
    agentUserId: String(internalUserId),
    userId: internalUserId,
    model: 'router',
    systemPrompt: '',
  });
}

export interface RouteContext {
  env: Partial<AppEnv>;
  /** Correlates webhook logs with the entrypoint's X-Request-ID. */
  requestId: string;
  telegramFetch?: typeof fetch;
  now?: () => string;
  /** Conversational flow factory (Phase 6); production composes D1 + AI Router. */
  flow?: ConversationFlowFactory;
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
    return handleTelegramWebhook(request, ctx.env, ctx.requestId, {
      fetchImpl: ctx.telegramFetch,
      now: ctx.now,
      flow: ctx.flow ?? productionFlow(ctx.env),
    });
  }
  return Response.json({ error: 'Not found' }, { status: 404 });
}
