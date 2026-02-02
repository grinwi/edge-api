/**
 * Edge API: Global JSON API with Edge Caching
 *
 * Endpoints
 * - GET /status                 -> health check JSON
 * - GET /data                   -> fetches external API data and caches for 30 seconds
 * - GET /weather?lat=..&lon=..  -> current weather + precipitation for next 3 hours
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

    // Weather endpoint: current conditions and next 3 hours precipitation via Open-Meteo
    if (url.pathname === '/weather') {
      const latStr = url.searchParams.get('lat');
      const lonStr = url.searchParams.get('lon');

      const badReq = (msg: string) => new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });

      if (!latStr || !lonStr) {
        return badReq('Missing required query params: lat and lon');
      }

      const lat = Number(latStr);
      const lon = Number(lonStr);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return badReq('lat and lon must be numbers');
      }
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return badReq('lat must be between -90..90 and lon between -180..180');
      }

      // Cache by exact URL (includes lat/lon). Keep short for freshness.
      const cache = caches.default;
      const cacheKey = new Request(url.toString());
      const cached = await cache.match(cacheKey);
      if (cached) {
        return cached;
      }

      // Open-Meteo free API, no key required
      const upstreamUrl = new URL('https://api.open-meteo.com/v1/forecast');
      upstreamUrl.searchParams.set('latitude', lat.toString());
      upstreamUrl.searchParams.set('longitude', lon.toString());
      // Request current metrics, and hourly precipitation to extract next 3 hours
      upstreamUrl.searchParams.set('current', 'temperature_2m,precipitation,weather_code,wind_speed_10m');
      upstreamUrl.searchParams.set('hourly', 'precipitation,precipitation_probability');
      upstreamUrl.searchParams.set('timezone', 'UTC');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      try {
        const res = await fetch(upstreamUrl.toString(), {
          signal: controller.signal,
          headers: { 'Accept': 'application/json' },
          cf: { cacheTtl: 120, cacheEverything: true }
        });
        if (!res.ok) {
          return new Response(JSON.stringify({ error: 'Upstream API error', status: res.status }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const data: any = await res.json();

        // Extract current weather (prefer new `current` fields; fallback to `current_weather` if present)
        const current = (() => {
          if (data.current) {
            return {
              temperature_c: data.current.temperature_2m ?? null,
              precipitation_mm: data.current.precipitation ?? null,
              weather_code: data.current.weather_code ?? null,
              wind_speed_10m: data.current.wind_speed_10m ?? null,
              time: data.current.time ?? null
            };
          }
          if (data.current_weather) {
            return {
              temperature_c: data.current_weather.temperature ?? null,
              precipitation_mm: null,
              weather_code: data.current_weather.weathercode ?? null,
              wind_speed_10m: data.current_weather.windspeed ?? null,
              time: data.current_weather.time ?? null
            };
          }
          return null;
        })();

        // Build next 3 hours precipitation timeline from hourly arrays
        let next3h: Array<{ time: string; precipitation_mm: number | null; precipitation_probability: number | null }> = [];
        if (data.hourly && Array.isArray(data.hourly.time)) {
          const times: string[] = data.hourly.time;
          const precip: Array<number | null> = data.hourly.precipitation || [];
          const precipProb: Array<number | null> = data.hourly.precipitation_probability || [];

          const nowIso = new Date().toISOString();
          for (let i = 0; i < times.length; i++) {
            if (times[i] >= nowIso) {
              next3h.push({
                time: times[i],
                precipitation_mm: precip[i] ?? null,
                precipitation_probability: precipProb[i] ?? null
              });
              if (next3h.length >= 3) break;
            }
          }
        }

        const payload = {
          lat,
          lon,
          current,
          next3h
        };

        const response = new Response(JSON.stringify(payload), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=120'
          }
        });
        // Populate edge cache asynchronously
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (err) {
        const status = (err as any)?.name === 'AbortError' ? 504 : 500;
        return new Response(JSON.stringify({ error: 'Weather fetch failed' }), {
          status,
          headers: { 'Content-Type': 'application/json' }
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    return new Response('Not Found', { status: 404 });
  }
} satisfies ExportedHandler<Env>;
