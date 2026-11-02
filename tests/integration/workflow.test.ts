import path from 'node:path';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HotelOffer, SupplierHotel, SupplierName } from '../../src/domain/types';
import type { Activities } from '../../src/orchestration/activities';
import { createOfferOrchestrator, OrchestrationError } from '../../src/orchestration/client';

// Real Temporal dev server + the real workflow code; only the activities are fakes.
let env: TestWorkflowEnvironment;
let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
let queueCounter = 0;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  env = await TestWorkflowEnvironment.createLocal();
  workflowBundle = await bundleWorkflowCode({
    workflowsPath: path.resolve(__dirname, '../../src/orchestration/workflows.ts'),
    logger: new DefaultLogger('ERROR'),
  });
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const INVENTORY: Record<SupplierName, SupplierHotel[]> = {
  supplierA: [
    { hotelId: 'a1', name: 'Holtin', city: 'delhi', price: 6000, commissionPct: 10 },
    { hotelId: 'a2', name: 'Taj', city: 'delhi', price: 8000, commissionPct: 10 },
  ],
  supplierB: [
    { hotelId: 'b1', name: 'holtin', city: 'delhi', price: 5340, commissionPct: 20 },
    { hotelId: 'b2', name: 'Leela', city: 'delhi', price: 7000, commissionPct: 12 },
  ],
};

type FetchImpl = (supplier: SupplierName, city: string) => Promise<SupplierHotel[]>;

function fakeActivities(fetch: FetchImpl = async (s) => INVENTORY[s]) {
  return {
    fetchSupplier: vi.fn<Activities['fetchSupplier']>(fetch),
    saveToCache: vi.fn<Activities['saveToCache']>(async () => undefined),
  };
}

/** Runs `body` while a worker with the given activities polls a fresh task queue. */
async function withWorker<T>(
  activities: ReturnType<typeof fakeActivities>,
  body: (orchestrator: ReturnType<typeof createOfferOrchestrator>) => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const taskQueue = `test-${++queueCounter}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle,
    activities,
  });
  const orchestrator = createOfferOrchestrator({
    client: env.client,
    taskQueue,
    supplierTimeoutMs: 200,
    timeoutMs,
  });
  return worker.runUntil(body(orchestrator));
}

const callsFor = (activities: ReturnType<typeof fakeActivities>, supplier: SupplierName) =>
  activities.fetchSupplier.mock.calls.filter(([s]) => s === supplier).length;

describe('getHotelOffersWorkflow', () => {
  it('merges both suppliers and caches the result', async () => {
    const activities = fakeActivities();
    const result = await withWorker(activities, (o) => o.fetchOffers('delhi'));

    expect(result.offers.map((o) => [o.name, o.price, o.supplier])).toEqual([
      ['holtin', 5340, 'supplierB'],
      ['Leela', 7000, 'supplierB'],
      ['Taj', 8000, 'supplierA'],
    ]);
    expect(result).toMatchObject({ degraded: [], cached: true });
    expect(activities.saveToCache).toHaveBeenCalledWith('delhi', result.offers, []);
  });

  it('normalises the city before calling suppliers', async () => {
    const activities = fakeActivities();
    await withWorker(activities, (o) => o.fetchOffers('  Delhi '));
    expect(activities.fetchSupplier).toHaveBeenCalledWith('supplierA', 'delhi');
  });

  it('returns the healthy supplier and flags the failed one', async () => {
    const activities = fakeActivities(async (s) => {
      if (s === 'supplierB') throw new Error('connection reset');
      return INVENTORY[s];
    });
    const result = await withWorker(activities, (o) => o.fetchOffers('delhi'));

    expect(result.degraded).toEqual(['supplierB']);
    expect(result.offers.every((o: HotelOffer) => o.supplier === 'supplierA')).toBe(true);
    expect(callsFor(activities, 'supplierB')).toBe(2); // first attempt + one retry
  });

  it('does not retry a non-retryable supplier failure', async () => {
    const activities = fakeActivities(async (s) => {
      if (s === 'supplierB') {
        throw ApplicationFailure.create({ message: 'not a list', nonRetryable: true });
      }
      return INVENTORY[s];
    });
    const result = await withWorker(activities, (o) => o.fetchOffers('delhi'));

    expect(result.degraded).toEqual(['supplierB']);
    expect(callsFor(activities, 'supplierB')).toBe(1);
  });

  it('fails with ALL_SUPPLIERS_FAILED when both suppliers fail, and caches nothing', async () => {
    const activities = fakeActivities(async () => {
      throw ApplicationFailure.create({ message: 'down', nonRetryable: true });
    });
    const err = await withWorker(activities, (o) => o.fetchOffers('delhi').catch((e) => e));

    expect(err).toBeInstanceOf(OrchestrationError);
    expect(err.code).toBe('ALL_SUPPLIERS_FAILED');
    expect(activities.saveToCache).not.toHaveBeenCalled();
  });

  it('still returns offers when the cache write fails', async () => {
    const activities = fakeActivities();
    activities.saveToCache.mockRejectedValue(new Error('redis down'));
    const result = await withWorker(activities, (o) => o.fetchOffers('delhi'));

    expect(result.offers).toHaveLength(3);
    expect(result.cached).toBe(false);
  });

  it('runs one workflow for concurrent requests on the same city', async () => {
    const activities = fakeActivities(async (s) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return INVENTORY[s];
    });
    const results = await withWorker(activities, (o) =>
      Promise.all(Array.from({ length: 5 }, () => o.fetchOffers('delhi'))),
    );

    expect(results).toHaveLength(5);
    expect(new Set(results.map((r) => r.fetchedAt)).size).toBe(1);
    expect(activities.fetchSupplier).toHaveBeenCalledTimes(2); // once per supplier, not 10
  });
});

describe('createOfferOrchestrator', () => {
  it('times out when no worker is polling the task queue', async () => {
    const orchestrator = createOfferOrchestrator({
      client: env.client,
      taskQueue: 'nobody-listens',
      supplierTimeoutMs: 200,
      timeoutMs: 500,
    });
    const started = Date.now();
    const err = await orchestrator.fetchOffers('goa').catch((e) => e);

    expect(err).toBeInstanceOf(OrchestrationError);
    expect(err.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
