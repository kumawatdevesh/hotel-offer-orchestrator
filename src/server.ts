import { once } from 'node:events';
import type { Server } from 'node:http';
import { Client, Connection } from '@temporalio/client';
import type Redis from 'ioredis';
import { createApp } from './app';
import { createHotelCache } from './cache/hotelCache';
import { createRedis } from './cache/redis';
import { config } from './config/env';
import { logger } from './config/logger';
import { createOfferOrchestrator } from './orchestration/client';
import { loadOpenApiSpec } from './routes/docs.routes';
import { createHealthProbes } from './services/health.probes';
import { createHealthService } from './services/health.service';
import { createCircuitBreaker } from './suppliers/circuitBreaker';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const redis = createRedis(config.REDIS_URL);
  // Give Redis a moment so the first requests can use the cache, but start anyway:
  // every cache call already degrades to a miss while Redis is unreachable.
  await Promise.race([once(redis, 'ready'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (redis.status !== 'ready') logger.warn('redis not ready at startup; serving without cache');

  // Lazy: the API boots even if Temporal is down; requests then fall back to cache.
  const connection = Connection.lazy({ address: config.TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: config.TEMPORAL_NAMESPACE });

  const app = createApp({
    cache: createHotelCache(redis, {
      freshTtlSeconds: config.CACHE_FRESH_TTL_SECONDS,
      hardTtlSeconds: config.CACHE_HARD_TTL_SECONDS,
    }),
    orchestrator: createOfferOrchestrator({
      client,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      supplierTimeoutMs: config.SUPPLIER_TIMEOUT_MS,
      timeoutMs: config.WORKFLOW_TIMEOUT_MS,
    }),
    health: createHealthService({
      probes: createHealthProbes({
        redis,
        temporal: client,
        namespace: config.TEMPORAL_NAMESPACE,
        taskQueue: config.TEMPORAL_TASK_QUEUE,
        // Read-only here: the API only reports circuit state; workers change it.
        breaker: createCircuitBreaker(redis, {
          failureThreshold: config.CIRCUIT_FAILURE_THRESHOLD,
          openMs: config.CIRCUIT_OPEN_SECONDS * 1_000,
          resetWindowMs: config.CIRCUIT_RESET_WINDOW_SECONDS * 1_000,
          log: logger,
        }),
        supplierTimeoutMs: config.HEALTH_PROBE_TIMEOUT_MS,
      }),
      probeTimeoutMs: config.HEALTH_PROBE_TIMEOUT_MS,
      cacheMs: config.HEALTH_CACHE_MS,
    }),
    serveMockSuppliers: config.SERVE_MOCK_SUPPLIERS,
    allowChaos: config.NODE_ENV !== 'production',
    openApiSpec: loadOpenApiSpec(),
  });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening');
  });
  server.on('error', (err) => {
    logger.fatal({ err, port: config.PORT }, 'http server failed');
    process.exit(1);
  });

  const resources: Resources = { server, redis, connection };
  process.on('SIGTERM', () => shutdown('SIGTERM', resources));
  process.on('SIGINT', () => shutdown('SIGINT', resources));
}

interface Resources {
  server: Server;
  redis: Redis;
  connection: Connection;
}

let stopping = false;

/** Stop accepting connections, let in-flight requests finish, then release clients. */
function shutdown(signal: string, { server, redis, connection }: Resources): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();

  server.close(async () => {
    await Promise.allSettled([redis.quit(), connection.close()]);
    logger.info('shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections();
}

main().catch((err) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
