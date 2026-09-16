import { validateEnv, type AppEnv } from './env';
import { route } from './router';

export default {
  fetch(request: Request, env: Partial<AppEnv>): Response {
    const requestId = crypto.randomUUID();
    let response: Response;
    try {
      validateEnv(env);
      response = route(request);
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
} satisfies ExportedHandler<Partial<AppEnv>>;
