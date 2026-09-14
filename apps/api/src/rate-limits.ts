import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';
export function requestLimits(apiLimit = 180, authLimit = 30) {
  const auth = (req: Request) => ['/api/auth/login', '/api/auth/callback'].includes(req.path);
  const handler = (req: Request, res: Response) => {
    const seconds = Math.max(1, Number(res.getHeader('Retry-After')) || 60);
    if (auth(req) && req.accepts('html'))
      return res
        .status(429)
        .type('html')
        .send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RARE OS — Please wait</title><main><h1>Please wait before signing in again</h1><p>Too many sign-in requests. Wait ${seconds} seconds, then try again.</p><p><a href="/api/auth/login">Try sign-in again</a> · <a href="/">Back to RARE OS</a></p></main></html>`,
        );
    return res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: `Too many requests. Wait ${seconds} seconds, then retry.`,
        retryAfterSeconds: seconds,
      },
    });
  };
  return [
    rateLimit({
      windowMs: 60000,
      limit: authLimit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => !auth(req),
      keyGenerator: (req) => req.path + ':' + ipKeyGenerator(req.ip || ''),
      handler,
    }),
    rateLimit({
      windowMs: 60000,
      limit: apiLimit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => auth(req) || req.path === '/api/health',
      keyGenerator: (req) =>
        req.session?.subject ? 'session:' + req.sessionID : 'ip:' + ipKeyGenerator(req.ip || ''),
      handler,
    }),
  ];
}
