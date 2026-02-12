/**
 * Generic byte-range proxy for direct HTTP(S) video URLs.
 *
 * GET /video?url=https://...
 * - Forwards Range and validators; returns upstream status and headers.
 * - CORS enabled for browser playback.
 */
export async function handleVideo(request: Request, env: Env, _ctx: ExecutionContext, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': 'GET, HEAD' } });
  }

  const target = url.searchParams.get('url');
  if (!target) {
    return new Response(JSON.stringify({ error: 'Missing required query param: url' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid url' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    return new Response(JSON.stringify({ error: 'Only http(s) URLs are allowed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Optional host allowlist via environment variable (comma-separated)
  const allowedHosts = ((env as { ALLOWED_VIDEO_HOSTS?: string })?.ALLOWED_VIDEO_HOSTS ?? '')
    .split(',')
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);

  if (allowedHosts.length > 0 && !allowedHosts.includes(targetUrl.hostname)) {
    return new Response(JSON.stringify({ error: 'Host not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const forwardHeaders = new Headers();
  for (const h of ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) {
    const v = request.headers.get(h);
    if (v) forwardHeaders.set(h, v);
  }

  const upstream = await fetch(targetUrl.toString(), {
    method: request.method,
    headers: forwardHeaders,
    // Disable CF cache for ranged streaming; let the origin control caching
    cf: { cacheTtl: 0 }
  });

  // Build a filtered set of response headers to avoid leaking hop-by-hop headers
  const keep = [
    'content-type',
    'content-length',
    'accept-ranges',
    'content-range',
    'etag',
    'last-modified',
    'date',
    'cache-control',
    'expires',
    'vary',
    'location'
  ];
  const outHeaders = new Headers();
  for (const h of keep) {
    const v = upstream.headers.get(h);
    if (v) outHeaders.set(h, v);
  }
  // Make it embeddable by browsers <video> tags and MSE
  outHeaders.set('Access-Control-Allow-Origin', '*');
  // Ensure clients know range requests are supported even if origin omitted it
  if (!outHeaders.has('accept-ranges')) outHeaders.set('Accept-Ranges', 'bytes');

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: outHeaders
  });
}
