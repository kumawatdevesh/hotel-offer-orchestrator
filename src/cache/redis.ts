import Redis from 'ioredis';
import { logger } from '../logger';

/**
 * One shared connection per process. Commands fail fast while Redis is down
 * instead of queueing, so callers can fall back or return 503 quickly.
 */
export function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
  redis.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));
  return redis;
}
