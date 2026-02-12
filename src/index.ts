/**
 * Edge API: Modular Router (clean, maintainable)
 *
 * Namespaces
 * - Weather:    GET /weather (short), GET /weather/forecast (daily up to 16 days, by city or coords)
 * - Exchange:   GET /exchange (latest FX rates)
 * - Webcam:     GET /webcam/stream, POST /webcam/ptz (bridge-backed)
 * - Camera:     GET /camera/stream, POST /camera/ptz (bridge-backed)
 * - Video:      GET /video (generic byte-range proxy)
 * - Utilities:  GET /status, GET /data (sample)
 *
 * Design
 * - Single place to declare routes (ROUTES map) -> improves discoverability.
 * - Each feature lives in src/routes/* with focused handlers and comments.
 * - Keep /exchange inline for now (simple wrapper); easy to move later.
 */

import { handleStatus } from './routes/status';
import { handleData } from './routes/data';
import { handleWeatherNow, handleWeatherForecast } from './routes/weather';
import { handleVideo } from './routes/video';
import { handleCameraStream, handleCameraPtz } from './routes/camera';
import { handleWebcamStream, handleWebcamPtz } from './routes/webcam';

// Route path constants to avoid string literal drift across files
const PATH = {
  STATUS: '/status',
  DATA: '/data',
  WEATHER_NOW: '/weather',
  WEATHER_FORECAST: '/weather/forecast',
  EXCHANGE: '/exchange',
  VIDEO: '/video',
  CAMERA_STREAM: '/camera/stream',
  CAMERA_PTZ: '/camera/ptz',
  WEBCAM_STREAM: '/webcam/stream',
  WEBCAM_PTZ: '/webcam/ptz'
} as const;

type Handler = (request: Request, env: Env, ctx: ExecutionContext, url: URL) => Promise<Response>;

/**
 * Central route registry. Handlers are small delegators to feature modules.
 * Method checks are left to the handlers (so OPTIONS/POST logic stays local to a module).
 */
const ROUTES: Record<string, Handler> = {
  [PATH.STATUS]: (req) => handleStatus(req),
  [PATH.DATA]: (req, env, ctx, url) => handleData(req, env, ctx, url),
  [PATH.WEATHER_NOW]: (req, env, ctx, url) => handleWeatherNow(req, env, ctx, url),
  [PATH.WEATHER_FORECAST]: (req, env, ctx, url) => handleWeatherForecast(req, env, ctx, url),
  [PATH.EXCHANGE]: (req, env, ctx, url) => handleExchange(req, env, ctx, url),
  [PATH.VIDEO]: (req, env, ctx, url) => handleVideo(req, env, ctx, url),
  [PATH.CAMERA_STREAM]: (req, env, ctx, url) => handleCameraStream(req, env, ctx, url),
  [PATH.CAMERA_PTZ]: (req, env, ctx) => handleCameraPtz(req, env, ctx),
  [PATH.WEBCAM_STREAM]: (req, env, ctx, url) => handleWebcamStream(req, env, ctx, url),
  [PATH.WEBCAM_PTZ]: (req, env, ctx, url) => handleWebcamPtz(req, env, ctx, url)
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];
    if (handler) return handler(request, env, ctx, url);
    return notFound();
  }
} satisfies ExportedHandler<Env>;

/**
 * Exchange rates (thin inline wrapper)
 *
 * GET /exchange?base=USD&symbols=EUR,CZK
 * - Uses frankfurter.app latest rates.
 * - Edge cache for 6 hours.
 */
async function handleExchange(_request: Request, _env: Env, _ctx: ExecutionContext, url: URL): Promise<Response> {
  const base = (url.searchParams.get('base') || 'USD').toUpperCase();
  const symbols = url.searchParams.get('symbols');

  const u = new URL('https://api.frankfurter.app/latest');
  u.searchParams.set('from', base);
  if (symbols) u.searchParams.set('to', symbols);

  const res = await fetch(u.toString(), { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 21600, cacheEverything: true } });
  if (!res.ok) return json({ error: 'Upstream exchange failed', status: res.status }, 502);
  const x = (await res.json()) as { base?: string; date?: string; rates?: Record<string, number> };
  return json({ base: x.base || base, date: x.date, rates: x.rates || {} }, 200, { 'Cache-Control': 'public, max-age=21600' });
}

// ---------- Small response helpers (local to router) ----------
function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  const h = new Headers({ 'Content-Type': 'application/json', ...headers });
  return new Response(JSON.stringify(data), { status, headers: h });
}
function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}
