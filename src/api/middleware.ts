import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { logger } from '../logger';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
    log: Logger;
  }
}

/** Reuses an incoming x-request-id (e.g. from a gateway) or mints one, and logs each request once. */
export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && /^[\w-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  req.log = logger.child({ requestId: req.id });
  res.setHeader('x-request-id', req.id);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    req.log.info(
      {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      },
      'request completed',
    );
  });
  next();
};

/** Express 4 does not catch rejected promises from async handlers; this forwards them to `next`. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.path}` } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'request body is not JSON' } });
    return;
  }
  (req.log ?? logger).error({ err }, 'unhandled error');
  if (res.headersSent) return;
  res.status(500).json({ error: { code: 'INTERNAL', message: 'internal server error' } });
};
