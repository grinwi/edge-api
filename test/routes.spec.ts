import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

/**
 * Router-level tests that avoid external network calls by focusing
 * on validation and method handling. This ensures endpoints are wired
 * correctly after modularization without depending on upstream APIs.
 */

describe('Modular Router endpoints (validation and method checks)', () => {
  it('GET /weather/forecast returns 400 when missing both city and coords', async () => {
    const res = await SELF.fetch(new Request('http://example.com/weather/forecast'));
    expect(res.status).toBe(400);
  });

  it('GET /weather/forecast returns 400 when both q and lat/lon provided', async () => {
    const res = await SELF.fetch(new Request('http://example.com/weather/forecast?q=Prague&lat=50&lon=14'));
    expect(res.status).toBe(400);
  });

  it('GET /video returns 400 when missing url param', async () => {
    const res = await SELF.fetch(new Request('http://example.com/video'));
    expect(res.status).toBe(400);
  });

  it('GET /webcam/stream returns 400 when missing cameraId', async () => {
    const res = await SELF.fetch(new Request('http://example.com/webcam/stream'));
    expect(res.status).toBe(400);
  });

  it('GET /camera/ptz returns 405 (method not allowed)', async () => {
    const res = await SELF.fetch(new Request('http://example.com/camera/ptz'));
    expect(res.status).toBe(405);
  });

  it('POST /webcam/ptz returns 400 when body is invalid JSON', async () => {
    const res = await SELF.fetch(new Request('http://example.com/webcam/ptz', { method: 'POST', body: 'not-json', headers: { 'Content-Type': 'application/json' } }));
    expect(res.status).toBe(400);
  });
});
