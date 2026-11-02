import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { logger } from '../config/logger';

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
