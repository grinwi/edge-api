/**
 * Edge API: Global JSON API with Edge Caching
 *
 * Endpoints
 * - GET /status -> health check JSON
 * - GET /data   -> fetches external API data and caches for 30 seconds
 */

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      const body = JSON.stringify({ status: 'ok', timestamp: Date.now() });
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          // Small cache to avoid stampedes for status, adjust as desired
          'Cache-Control': 'public, max-age=5'
        }
      });
    }

    if (url.pathname === '/data') {
      // Cache key based on request URL; only GET is cacheable
      const cache = caches.default;
      const cacheKey = new Request(url.toString());

      // Fast path: serve from cache if present
      const cached = await cache.match(cacheKey);
      if (cached) {
        return cached;
      }

      // Primary provider: CoinGecko (may return 403/429 under some networks)
      // Fallback provider: Chuck Norris jokes (no auth)
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

      // Add a timeout to handle flaky networks during local dev or proxy hiccups
      const controller = new AbortController();
      const timeoutMs = 4500;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        for (const p of providers) {
          try {
            // Use Cloudflare cache override for upstream fetch to respect a 30s TTL
            const upstream = await fetch(p.url, {
              signal: controller.signal,
              headers: {
                'User-Agent': 'edge-api/1.0 (+https://workers.dev)',
                'Accept': 'application/json'
              },
              cf: {
                cacheTtl: 30,
                cacheEverything: true
              }
            });

            if (!upstream.ok) {
              // Try next provider on common upstream blocks or server errors
              if (upstream.status === 403 || upstream.status === 429 || upstream.status >= 500) {
                continue;
              }
              // Return error for other non-OK statuses
              return new Response(
                JSON.stringify({ error: 'Upstream API error', status: upstream.status }),
                { status: 502, headers: { 'Content-Type': 'application/json' } }
              );
            }

            const data = await upstream.json();
            const payload = p.transform(data);
            const response = new Response(JSON.stringify({ provider: p.name, payload }), {
              headers: {
                'Content-Type': 'application/json',
                // Advertise caching to clients and to Cloudflare edge
                'Cache-Control': 'public, max-age=30'
              }
            });

            // Populate edge cache asynchronously
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
            return response;
          } catch (e) {
            // On network error or timeout, try next provider
            // If AbortError, we still attempt next provider in case of transient issues
            continue;
          }
        }

        // If all providers failed
        return new Response(JSON.stringify({ error: 'All providers failed' }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' }
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    return new Response('Not Found', { status: 404 });
  }
} satisfies ExportedHandler<Env>;
