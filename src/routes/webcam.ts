/**
 * Webcam namespace as aliases for camera endpoints (modular)
 *
 * GET /webcam/stream?cameraId=ID | ?id=ID
 * POST /webcam/ptz { cameraId|id, action, durationMs? }
 */
import { handleCameraStream, handleCameraPtz } from './camera';

export async function handleWebcamStream(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  // Normalize id -> cameraId for convenience
  if (!url.searchParams.get('cameraId') && url.searchParams.get('id')) {
    url.searchParams.set('cameraId', url.searchParams.get('id') as string);
  }
  return handleCameraStream(request, env, ctx, url);
}

export async function handleWebcamPtz(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  return handleCameraPtz(request, env, ctx);
}
