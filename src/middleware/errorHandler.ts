import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '../config/logger';

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
