import Redis from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCircuitBreaker } from '../../src/suppliers/circuitBreaker';

const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15');
const log = pino({ level: 'silent' });
const breaker = createCircuitBreaker(redis, {
  failureThreshold: 3,
  openMs: 150,
  resetWindowMs: 400,
  log,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fail(times: number) {
  for (let i = 0; i < times; i++) await breaker.recordFailure('supplierB');
}

beforeAll(async () => {
  await redis.ping();
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis.quit();
});

describe('circuit breaker', () => {
  it('starts closed', async () => {
    expect(await breaker.canCall('supplierB')).toBe(true);
    expect(await breaker.getState('supplierB')).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
    });
  });

  it('stays closed below the threshold', async () => {
    await fail(2);
    expect(await breaker.canCall('supplierB')).toBe(true);
  });

  it('opens at the threshold and reports when it will retry', async () => {
    await fail(3);
    expect(await breaker.canCall('supplierB')).toBe(false);
    const state = await breaker.getState('supplierB');
    expect(state.state).toBe('open');
    expect(state.retryInMs).toBeGreaterThan(0);
  });

  it('tracks suppliers independently', async () => {
    await fail(3);
    expect(await breaker.canCall('supplierA')).toBe(true);
  });

  it('a success resets the count', async () => {
    await fail(2);
    await breaker.recordSuccess('supplierB');
    await fail(2);
    expect(await breaker.canCall('supplierB')).toBe(true);
  });

  it('allows a trial call after the open period, and one failed trial re-opens it', async () => {
    await fail(3);
    await sleep(200);
    expect(await breaker.canCall('supplierB')).toBe(true);

    await fail(1);
    expect(await breaker.canCall('supplierB')).toBe(false);
  });

  it('closes for good after a successful trial call', async () => {
    await fail(3);
    await sleep(200);
    await breaker.recordSuccess('supplierB');
    await fail(1);
    expect(await breaker.canCall('supplierB')).toBe(true);
  });

  it('forgets old failures after a quiet reset window', async () => {
    await fail(2);
    await sleep(450);
    await fail(1);
    expect(await breaker.canCall('supplierB')).toBe(true);
  });

  it('allows calls when Redis is unreachable', async () => {
    const down = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    const offline = createCircuitBreaker(down, {
      failureThreshold: 1,
      openMs: 1_000,
      resetWindowMs: 2_000,
      log,
    });

    await offline.recordFailure('supplierB');
    expect(await offline.canCall('supplierB')).toBe(true);
    down.disconnect();
  });
});
