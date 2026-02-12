/**
 * Status endpoint
 *
 * GET /status
 * - Returns a simple health payload with current timestamp.
 */
export async function handleStatus(_request: Request): Promise<Response> {
  const body = JSON.stringify({ status: 'ok', timestamp: Date.now() });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=5'
    }
  });
}
