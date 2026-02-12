/**
 * Camera (bridge-backed) endpoints (modular)
 *
 * GET /camera/stream?cameraId=ID
 * - Proxies a stream from an external bridge service that integrates with the camera/cloud app.
 * - Forwards Range/validators, preserves upstream headers needed for seekable playback.
 *
 * POST /camera/ptz { cameraId, action: up|down|left|right|stop, durationMs? }
 * - Forwards PTZ controls to the bridge with CORS preflight support.
 */

export async function handleCameraStream(request: Request, env: Env, _ctx: ExecutionContext, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': 'GET, HEAD' } });
  }
  const cameraId = url.searchParams.get('cameraId');
  if (!cameraId) return new Response(JSON.stringify({ error: 'Missing required query param: cameraId' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const bridgeBase = (env as any)?.BRIDGE_BASE as string | undefined;
  const bridgeToken = (env as any)?.BRIDGE_TOKEN as string | undefined;
  if (!bridgeBase) return new Response(JSON.stringify({ error: 'Bridge not configured', missing: ['BRIDGE_BASE'] }), { status: 501, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  const upstreamUrl = new URL(`/camera/${encodeURIComponent(cameraId)}/stream`, bridgeBase).toString();
  const headers = new Headers();
  for (const h of ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (bridgeToken) headers.set('Authorization', `Bearer ${bridgeToken}`);

  const upstream = await fetch(upstreamUrl, { method: request.method, headers, cf: { cacheTtl: 0 } });

  const keep = ['content-type','content-length','accept-ranges','content-range','etag','last-modified','date','cache-control','expires','vary'];
  const out = new Headers();
  for (const h of keep) { const v = upstream.headers.get(h); if (v) out.set(h, v); }
  out.set('Access-Control-Allow-Origin', '*');
  if (!out.has('accept-ranges')) out.set('Accept-Ranges', 'bytes');

  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
}

export async function handleCameraPtz(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600'
      }
    });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': 'POST, OPTIONS' } });
  }

  let body: any;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }); }

  const cameraId: string | undefined = body?.cameraId;
  const action: string | undefined = body?.action;
  const durationMs: number | undefined = body?.durationMs;
  const validActions = new Set(['up', 'down', 'left', 'right', 'stop']);
  if (!cameraId || !action || !validActions.has(action)) {
    return new Response(JSON.stringify({ error: 'Missing/invalid cameraId or action', allowedActions: Array.from(validActions) }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }

  const bridgeBase = (env as any)?.BRIDGE_BASE as string | undefined;
  const bridgeToken = (env as any)?.BRIDGE_TOKEN as string | undefined;
  if (!bridgeBase) return new Response(JSON.stringify({ error: 'Bridge not configured', missing: ['BRIDGE_BASE'] }), { status: 501, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  const upstreamUrl = new URL(`/camera/${encodeURIComponent(cameraId)}/ptz`, bridgeBase).toString();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (bridgeToken) headers.set('Authorization', `Bearer ${bridgeToken}`);

  const upstream = await fetch(upstreamUrl, { method: 'POST', headers, body: JSON.stringify({ action, durationMs }) });
  const text = await upstream.text();
  const outHeaders = new Headers({ 'Access-Control-Allow-Origin': '*' });
  const ct = upstream.headers.get('content-type');
  if (ct) outHeaders.set('Content-Type', ct);
  return new Response(text, { status: upstream.status, headers: outHeaders });
}
