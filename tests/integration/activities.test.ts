import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import Redis from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHotelCache } from '../../src/cache/hotelCache';
import type { SupplierHotel, SupplierName } from '../../src/domain/types';
import { createActivities, SUPPLIER_CIRCUIT_OPEN } from '../../src/orchestration/activities';
import { createCircuitBreaker } from '../../src/suppliers/circuitBreaker';
import { SupplierError } from '../../src/suppliers/supplierClient';

const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15');
const breaker = createCircuitBreaker(redis, {
  failureThreshold: 3,
  openMs: 10_000,
  resetWindowMs: 20_000,
  log: pino({ level: 'silent' }),
});
const cache = createHotelCache(redis, { freshTtlSeconds: 600, hardTtlSeconds: 3_600 });
const env = new MockActivityEnvironment();
const B: SupplierName = 'supplierB';

const HOTELS: SupplierHotel[] = [
  { hotelId: 'b1', name: 'Leela', city: 'delhi', price: 7000, commissionPct: 12 },
];

const fetchHotels = vi.fn<(supplier: SupplierName, city: string) => Promise<SupplierHotel[]>>();
const activities = createActivities({ cache, breaker, fetchHotels });
const callB = () =>
  env.run(activities.fetchSupplier, B, 'delhi').then(
    () => undefined,
    (e: unknown) => e as ApplicationFailure,
  );

beforeAll(async () => {
  await redis.ping();
});

beforeEach(async () => {
  await redis.flushdb();
  fetchHotels.mockReset();
});

afterAll(async () => {
  await redis.quit();
});

describe('fetchSupplier activity with circuit breaker', () => {
  it('returns hotels and keeps the circuit closed', async () => {
    fetchHotels.mockResolvedValue(HOTELS);
    expect(await env.run(activities.fetchSupplier, B, 'delhi')).toEqual(HOTELS);
    expect((await breaker.getState('supplierB')).state).toBe('closed');
  });

  it('skips the supplier without calling it once the circuit opens', async () => {
    fetchHotels.mockRejectedValue(new SupplierError('supplierB', 'http', 'returned 500', true));
    for (let i = 0; i < 3; i++) await callB();
    expect(fetchHotels).toHaveBeenCalledTimes(3);

    const err = await callB();
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err?.type).toBe(SUPPLIER_CIRCUIT_OPEN);
    expect(err?.nonRetryable).toBe(true);
    expect(fetchHotels).toHaveBeenCalledTimes(3); // the 4th call never reached the supplier
  });

  it('counts timeouts against the supplier', async () => {
    fetchHotels.mockRejectedValue(new SupplierError('supplierB', 'timeout', 'timed out', false));
    for (let i = 0; i < 3; i++) await callB();
    expect((await breaker.getState('supplierB')).state).toBe('open');
  });

  it('does not blame the supplier for a 4xx caused by our request', async () => {
    fetchHotels.mockRejectedValue(new SupplierError('supplierB', 'http', 'returned 400', false));
    for (let i = 0; i < 5; i++) await callB();
    expect((await breaker.getState('supplierB')).state).toBe('closed');
  });

  it('keeps the original failure type for Temporal retry decisions', async () => {
    fetchHotels.mockRejectedValue(new SupplierError('supplierB', 'network', 'reset', true));
    const err = await callB();
    expect(err?.type).toBe('SUPPLIER_NETWORK');
    expect(err?.nonRetryable).toBe(false);
  });
});
