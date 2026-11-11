import type { NextFunction, Request, Response } from 'express';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth on top of SameSite=Lax cookies: a state-changing request that carries an Origin
 * header must come from the same host the API is served on (the web app is same-origin via proxy).
 */
export function originCheck(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (SAFE.has(req.method) || !origin) {
    next();
    return;
  }
  let host: string | undefined;
  try {
    host = new URL(origin).host;
  } catch {
    host = undefined;
  }
  if (host && host === req.headers.host) {
    next();
    return;
  }
  res.status(403).json({ statusCode: 403, error: 'forbidden', message: 'Cross-origin request refused' });
}
