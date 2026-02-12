/**
 * Weather endpoints (modular, readable, maintainable)
 *
 * Endpoints
 * - GET /weather?lat=..&lon=..
 *   Current conditions and next 3 hours precipitation using multi-provider fallback.
 *
 * - GET /weather/forecast?q=City | ?lat=..&lon=..[&days=1..16]
 *   Daily forecast up to 16 days (Open‑Meteo limit). Geocodes city names when q is provided.
 */

// -------------------- Types --------------------
export type WeatherPayload = {
  lat: number;
  lon: number;
  current: {
    temperature_c: number | null;
    precipitation_mm: number | null;
    weather_code: string | number | null;
    wind_speed_10m: number | null;
    time: string | null;
  } | null;
  next3h: Array<{ time: string; precipitation_mm: number | null; precipitation_probability: number | null }>;
};

type GeocodeResult = { lat: number; lon: number; place: { name?: string; country?: string } };

// -------------------- Constants --------------------
const OPEN_METEO_GC = 'https://geocoding-api.open-meteo.com/v1/search';
const OPEN_METEO_FC = 'https://api.open-meteo.com/v1/forecast';
const MET_NO_COMPACT = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

// -------------------- Public Handlers --------------------
/**
 * GET /weather
 * Returns current weather and precipitation outlook for the next 3 hours.
 * Uses two providers with graceful fallback and short-term edge caching.
 */
export async function handleWeatherNow(_request: Request, _env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const latStr = url.searchParams.get('lat');
  const lonStr = url.searchParams.get('lon');
  const badReq = (msg: string) => json({ error: msg }, 400);
  if (!latStr || !lonStr) return badReq('Missing required query params: lat and lon');

  const lat = Number(latStr);
  const lon = Number(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return badReq('lat and lon must be numbers');
  if (!validLat(lat) || !validLon(lon)) return badReq('lat must be between -90..90 and lon between -180..180');

  // Cache at the edge by exact query to reduce upstream calls.
  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  // Provider definitions kept small and local; transforms normalize output.
  const providers: Array<{ name: string; url: string; parse: (data: any) => WeatherPayload }> = [
    {
      name: 'open-meteo',
      url: buildOpenMeteoNowUrl(lat, lon),
      parse: (data: any) => parseOpenMeteoNow(data, lat, lon)
    },
    {
      name: 'met-no',
      url: buildMetNoCompactUrl(lat, lon),
      parse: (data: any) => parseMetNoNow(data, lat, lon)
    }
  ];

  try {
    for (const p of providers) {
      try {
        const res = await fetch(p.url, {
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'edge-api/1.0 (+https://edge-api.grinwi.workers.dev)'
          },
          cf: { cacheTtl: 120, cacheEverything: true }
        });
        if (!res.ok) {
          if (res.status === 403 || res.status === 429 || res.status >= 500) continue;
          return json({ error: 'Upstream API error', status: res.status }, 502);
        }
        const raw = await res.json();
        const payload = p.parse(raw);
        const response = json(payload, 200, { 'Cache-Control': 'public, max-age=120' });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch {
        continue;
      }
    }
    return json({ error: 'All weather providers failed' }, 504);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET /weather/forecast
 * Clean, readable flow:
 * 1) Parse query (either city name or lat/lon) and normalize coordinates
 * 2) Clamp requested days to provider limits
 * 3) Fetch forecast from Open‑Meteo
 * 4) Map the response to a compact, date-keyed structure
 */
export async function handleWeatherForecast(_request: Request, _env: Env, _ctx: ExecutionContext, url: URL): Promise<Response> {
  // 1) Parse query
  const parse = await parseForecastQuery(url);
  if ('error' in parse) return json({ error: parse.error }, 400);
  const { lat, lon, place } = parse;

  // 2) Clamp days to provider limits (1..16)
  const days = clampDays(url.searchParams.get('days'));

  // 3) Build upstream request and fetch with small edge cache
  const upstreamUrl = buildOpenMeteoForecastUrl(lat, lon, days);
  const res = await fetch(upstreamUrl, { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 900, cacheEverything: true } });
  if (!res.ok) return json({ error: 'Upstream weather failed', status: res.status }, 502);

  // 4) Map response
  const data = (await res.json()) as OpenMeteoDailyResponse;
  const daily = mapOpenMeteoDaily(data);

  const payload = {
    query: url.searchParams.get('q') ? { q: url.searchParams.get('q') } : { lat, lon },
    location: { lat, lon, ...place },
    days: daily.length,
    daily
  };
  return json(payload, 200, { 'Cache-Control': 'public, max-age=900' });
}

// -------------------- Helpers: Parsing and Validation --------------------
/** Valid latitude range check */
function validLat(lat: number): boolean { return lat >= -90 && lat <= 90; }
/** Valid longitude range check */
function validLon(lon: number): boolean { return lon >= -180 && lon <= 180; }

/** Clamp days parameter to [1,16], default 16 */
function clampDays(daysStr: string | null): number {
  const n = daysStr ? Number(daysStr) : 16;
  if (!Number.isFinite(n)) return 16;
  return Math.max(1, Math.min(16, n));
}

/**
 * Parse query for forecast endpoint. Accepts either:
 * - q=CityName
 * - lat=..&lon=..
 * Returns normalized coordinates and optional place metadata.
 */
async function parseForecastQuery(url: URL): Promise<GeocodeResult | { error: string } > {
  const q = url.searchParams.get('q');
  const latStr = url.searchParams.get('lat');
  const lonStr = url.searchParams.get('lon');

  // Exclusivity: either q or lat/lon, not both
  if (q && (latStr || lonStr)) return { error: 'Provide either q (city name) OR lat/lon, not both' };

  if (q) {
    const geo = new URL(OPEN_METEO_GC);
    geo.searchParams.set('name', q);
    geo.searchParams.set('count', '1');
    geo.searchParams.set('language', 'en');
    geo.searchParams.set('format', 'json');

    const gRes = await fetch(geo.toString(), { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!gRes.ok) return { error: `Geocoding failed (status ${gRes.status})` };
    const g = (await gRes.json()) as { results?: Array<{ latitude: number; longitude: number; name: string; country?: string }> };
    const first = Array.isArray(g.results) ? g.results[0] : undefined;
    if (!first) return { error: 'City not found' };
    return { lat: Number(first.latitude), lon: Number(first.longitude), place: { name: first.name, country: first.country } };
  }

  // Coordinates branch
  if (!latStr || !lonStr) return { error: 'Provide q (city name) or both lat and lon' };
  const lat = Number(latStr);
  const lon = Number(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: 'lat and lon must be numbers' };
  if (!validLat(lat) || !validLon(lon)) return { error: 'lat must be between -90..90 and lon between -180..180' };
  return { lat, lon, place: {} };
}

// -------------------- Helpers: Upstream URLs --------------------
function buildOpenMeteoNowUrl(lat: number, lon: number): string {
  const u = new URL(OPEN_METEO_FC);
  u.searchParams.set('latitude', lat.toString());
  u.searchParams.set('longitude', lon.toString());
  u.searchParams.set('current', 'temperature_2m,precipitation,weather_code,wind_speed_10m');
  u.searchParams.set('hourly', 'precipitation,precipitation_probability');
  u.searchParams.set('timezone', 'UTC');
  return u.toString();
}

function buildMetNoCompactUrl(lat: number, lon: number): string {
  const u = new URL(MET_NO_COMPACT);
  u.searchParams.set('lat', lat.toString());
  u.searchParams.set('lon', lon.toString());
  return u.toString();
}

function buildOpenMeteoForecastUrl(lat: number, lon: number, days: number): string {
  const u = new URL(OPEN_METEO_FC);
  u.searchParams.set('latitude', String(lat));
  u.searchParams.set('longitude', String(lon));
  u.searchParams.set('daily', 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,windspeed_10m_max');
  u.searchParams.set('timezone', 'UTC');
  u.searchParams.set('forecast_days', String(days));
  return u.toString();
}

// -------------------- Helpers: Parsing provider payloads --------------------
function parseOpenMeteoNow(data: any, lat: number, lon: number): WeatherPayload {
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
  return { lat, lon, current, next3h };
}

function parseMetNoNow(data: any, lat: number, lon: number): WeatherPayload {
  const ts = data?.properties?.timeseries;
  let current: WeatherPayload['current'] = null;
  let next3h: WeatherPayload['next3h'] = [];
  if (Array.isArray(ts) && ts.length > 0) {
    const first = ts[0];
    const details = first?.data?.instant?.details || {};
    const n1 = first?.data?.next_1_hours?.details || {};
    current = {
      temperature_c: details.air_temperature ?? null,
      precipitation_mm: n1.precipitation_amount ?? null,
      weather_code: first?.data?.next_1_hours?.summary?.symbol_code ?? null,
      wind_speed_10m: details.wind_speed ?? null,
      time: first?.time ?? null
    };

    const nowIso = new Date().toISOString();
    for (const entry of ts) {
      const t = entry?.time as string;
      if (!t || t < nowIso) continue;
      const n1h = entry?.data?.next_1_hours?.details || {};
      next3h.push({
        time: t,
        precipitation_mm: n1h.precipitation_amount ?? null,
        precipitation_probability: null
      });
      if (next3h.length >= 3) break;
    }
  }
  return { lat, lon, current, next3h };
}

// -------------------- Helpers: Mapping forecast daily --------------------
interface OpenMeteoDailyResponse {
  daily?: {
    time?: string[];
    weathercode?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    precipitation_probability_max?: number[];
    windspeed_10m_max?: number[];
  };
}

function mapOpenMeteoDaily(data: OpenMeteoDailyResponse): Array<{
  date: string;
  weather_code: number | null;
  temp_max_c: number | null;
  temp_min_c: number | null;
  precipitation_mm: number | null;
  precipitation_probability_percent: number | null;
  windspeed_10m_max_kmh: number | null;
}> {
  const d = data.daily || {};
  const out: Array<any> = [];
  const times: string[] = d.time || [];
  for (let i = 0; i < times.length; i++) {
    out.push({
      date: times[i],
      weather_code: d.weathercode?.[i] ?? null,
      temp_max_c: d.temperature_2m_max?.[i] ?? null,
      temp_min_c: d.temperature_2m_min?.[i] ?? null,
      precipitation_mm: d.precipitation_sum?.[i] ?? null,
      precipitation_probability_percent: d.precipitation_probability_max?.[i] ?? null,
      windspeed_10m_max_kmh: d.windspeed_10m_max?.[i] ?? null
    });
  }
  return out;
}

// -------------------- Helpers: Response --------------------
function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  const h = new Headers({ 'Content-Type': 'application/json', ...headers });
  return new Response(JSON.stringify(data), { status, headers: h });
}
