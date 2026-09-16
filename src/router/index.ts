export function route(request: Request): Response {
  const pathname = new URL(request.url).pathname;
  if (pathname !== '/healthz') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET, HEAD' } },
    );
  }
  return Response.json({ status: 'ok' });
}
