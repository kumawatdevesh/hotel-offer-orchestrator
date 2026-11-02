import { NativeConnection, Worker } from '@temporalio/worker';
import { createHotelCache } from './cache/hotelCache';
import { createRedis } from './cache/redis';
import { config } from './config/env';
import { logger } from './config/logger';
import { createActivities } from './orchestration/activities';
import { createCircuitBreaker } from './suppliers/circuitBreaker';

async function main(): Promise<void> {
  const redis = createRedis(config.REDIS_URL);
  const cache = createHotelCache(redis, {
    freshTtlSeconds: config.CACHE_FRESH_TTL_SECONDS,
    hardTtlSeconds: config.CACHE_HARD_TTL_SECONDS,
  });
  const breaker = createCircuitBreaker(redis, {
    failureThreshold: config.CIRCUIT_FAILURE_THRESHOLD,
    openMs: config.CIRCUIT_OPEN_SECONDS * 1_000,
    resetWindowMs: config.CIRCUIT_RESET_WINDOW_SECONDS * 1_000,
    log: logger,
  });
  const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });

  try {
    const worker = await Worker.create({
      connection,
      namespace: config.TEMPORAL_NAMESPACE,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      workflowsPath: require.resolve('./orchestration/workflows'),
      activities: createActivities({ cache, breaker }),
    });
    logger.info({ taskQueue: config.TEMPORAL_TASK_QUEUE }, 'worker started');
    // Resolves after SIGINT/SIGTERM once in-flight tasks finish (the SDK installs the handlers).
    await worker.run();
  } finally {
    await connection.close();
    await redis.quit();
    logger.info('worker stopped');
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'worker crashed');
  process.exit(1);
});
