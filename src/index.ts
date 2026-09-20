import { validateEnv, type AppEnv } from './env';
import { route } from './router';
import { cleanupExpiredPanels } from './telegram/panel-cleanup';

export default {
  async fetch(request: Request, env: Partial<AppEnv>, ctx?: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    let response: Response;
    try {
      validateEnv(env);
      // The execution context's waitUntil lets the Telegram webhook acknowledge
      // Telegram promptly while conversational processing (AI Router, provider
      // I/O, Telegram delivery) continues in the Workers background execution.
      // Without it, a slow provider generation holds the HTTP request open and
      // Telegram's ~60s webhook deadline cancels the isolate (outcome:
      // "canceled"), losing the generation mid-flight.
      const waitUntil = ctx ? (promise: Promise<unknown>): void => ctx.waitUntil(promise) : undefined;
      response = await route(request, { env, requestId, ...(waitUntil !== undefined ? { waitUntil } : {}) });
    } catch {
      console.error(JSON.stringify({ event: 'request_failed', request_id: requestId }));
      response = Response.json({ error: 'Something went wrong' }, { status: 500 });
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Request-ID', requestId);
    if (request.method === 'HEAD') {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  },

  // Scheduled admin panel cleanup (Telegram UX overhaul): every minute, the
  // cron deletes the Telegram messages of admin panels whose 5-minute
  // inactivity window expired and removes their durable session rows. Never a
  // setTimeout: it must survive isolate restarts and request cancellation.
  async scheduled(_controller: ScheduledController, env: Partial<AppEnv>, ctx: ExecutionContext): Promise<void> {
    if (!env.DB || typeof env.DB.prepare !== 'function') return;
    ctx.waitUntil(
      cleanupExpiredPanels(env.DB, env.TELEGRAM_BOT_TOKEN).catch(() => {
        console.error(JSON.stringify({ event: 'admin_panel_cleanup_failed' }));
      }),
    );
  },
} satisfies ExportedHandler<Partial<AppEnv>>;
