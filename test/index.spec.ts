import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Edge API', () => {
  it('/status returns ok and timestamp', async () => {
    const res = await SELF.fetch(new Request('http://example.com/status'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.status).toBe('ok');
    expect(typeof json.timestamp).toBe('number');
  });

  it('/weather returns 400 when missing lat/lon', async () => {
    const res = await SELF.fetch(new Request('http://example.com/weather'));
    expect(res.status).toBe(400);
  });

  it('/weather returns 400 when invalid values', async () => {
    const res = await SELF.fetch(new Request('http://example.com/weather?lat=abc&lon=2000'));
    expect(res.status).toBe(400);
  });
});
