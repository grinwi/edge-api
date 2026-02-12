/**
 * Data endpoint with multi-provider fallback and edge caching.
 *
 * GET /data
 * - Tries primary provider (CoinGecko), falls back to a joke API on rate-limit or server error.
 * - Advertises Cache-Control and populates Cloudflare edge cache for 30s.
 */
export async function handleData(_request: Request, _env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(url.toString());

  // Serve from edge cache when available
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Providers: primary and fallback, both JSON
  const providers = [
    {
      name: 'coingecko',
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      transform: (d: any) => d
    },
    {
      name: 'chucknorris',
      url: 'https://api.chucknorris.io/jokes/random',
      transform: (d: any) => ({ joke: d.value })
    }
  ] as const;

  const controller = new AbortController();
  const timeoutMs = 4500;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (const p of providers) {
      try {
        const upstream = await fetch(p.url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'edge-api/1.0 (+https://edge-api.grinwi.workers.dev)',
            'Accept': 'application/json'
          },
          cf: { cacheTtl: 30, cacheEverything: true }
        });

        if (!upstream.ok) {
          // Retry on common upstream rate-limits/blocks or server errors
          if (upstream.status === 403 || upstream.status === 429 || upstream.status >= 500) continue;
          return new Response(JSON.stringify({ error: 'Upstream API error', status: upstream.status }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const data = await upstream.json();
        const payload = p.transform(data);
        const response = new Response(JSON.stringify({ provider: p.name, payload }), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=30'
          }
        });

        // Populate edge cache asynchronously
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch {
        // network/timeout: try next provider
        continue;
      }
    }

    return new Response(JSON.stringify({ error: 'All providers failed' }), {
      status: 504,
      headers: { 'Content-Type': 'application/json' }
    });
  } finally {
    clearTimeout(timeout);
  }
}
