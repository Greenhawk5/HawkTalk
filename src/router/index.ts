import type { AppEnv } from '../env';
import { handleTelegramWebhook, TELEGRAM_WEBHOOK_PATH } from '../telegram/webhook';

export interface RouteContext {
  env: Partial<AppEnv>;
  /** Correlates webhook logs with the entrypoint's X-Request-ID. */
  requestId: string;
  telegramFetch?: typeof fetch;
  now?: () => string;
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
    });
  }
  return Response.json({ error: 'Not found' }, { status: 404 });
}
