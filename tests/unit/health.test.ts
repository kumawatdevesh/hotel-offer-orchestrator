import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createHealthController } from '../../src/controllers/health.controller';
import { createHealthRouter } from '../../src/routes/health.routes';
import { createHealthService, type HealthProbes } from '../../src/services/health.service';
import type { SupplierName } from '../../src/domain/types';

const ok = async () => undefined;
const fail = (message: string) => async () => {
  throw new Error(message);
};
const never = () => new Promise<void>(() => undefined);

/** All probes healthy unless a test overrides one. */
function probes(overrides: Partial<HealthProbes> = {}): HealthProbes {
  return {
    redis: ok,
    temporal: ok,
    workerPollers: async () => 1,
    supplier: ok,
    circuit: async () => ({ state: 'closed', consecutiveFailures: 0 }),
    ...overrides,
  };
}

function service(p: HealthProbes, clock = { t: 1_000_000 }) {
  return createHealthService({
    probes: p,
    probeTimeoutMs: 50,
    cacheMs: 5_000,
    now: () => clock.t,
    startedAt: 1_000_000 - 90_000,
  });
}

const onlyB =
  (fn: () => Promise<void>) =>
  async (s: SupplierName): Promise<void> =>
    s === 'supplierB' ? fn() : undefined;

describe('health service: overall status', () => {
  it('is ok when everything is up', async () => {
    const report = await service(probes()).check();
    expect(report.status).toBe('ok');
    expect(report.uptimeSeconds).toBe(90);
    expect(report.checks.workers).toMatchObject({ status: 'up', pollers: 1 });
    expect(report.checks.suppliers.supplierA).toMatchObject({ status: 'up', circuit: 'closed' });
  });

  it('is degraded when one supplier is down', async () => {
    const report = await service(probes({ supplier: onlyB(fail('returned 500')) })).check();
    expect(report.status).toBe('degraded');
    expect(report.checks.suppliers.supplierB).toMatchObject({
      status: 'down',
      error: 'returned 500',
    });
  });

  it('is degraded when a circuit is open, and says when it retries', async () => {
    const report = await service(
      probes({
        circuit: async (s) =>
          s === 'supplierB'
            ? { state: 'open', consecutiveFailures: 5, retryInMs: 21_000 }
            : { state: 'closed', consecutiveFailures: 0 },
      }),
    ).check();
    expect(report.status).toBe('degraded');
    expect(report.checks.suppliers.supplierB).toMatchObject({ circuit: 'open', retryInMs: 21_000 });
  });

  it('is degraded, not down, when only Redis is down', async () => {
    const report = await service(probes({ redis: fail('ECONNREFUSED') })).check();
    expect(report.status).toBe('degraded');
    expect(report.checks.redis).toMatchObject({ status: 'down', error: 'ECONNREFUSED' });
  });

  it('reports the circuit as unknown when its state cannot be read', async () => {
    const report = await service(probes({ circuit: fail('redis down') })).check();
    expect(report.checks.suppliers.supplierA.circuit).toBe('unknown');
  });

  it.each([
    ['Temporal is unreachable', probes({ temporal: fail('UNAVAILABLE') })],
    ['no worker is running', probes({ workerPollers: async () => 0 })],
    ['every supplier is down', probes({ supplier: fail('down') })],
  ])('is down when %s', async (_case, p) => {
    expect((await service(p).check()).status).toBe('down');
  });

  it('explains a missing worker', async () => {
    const report = await service(probes({ workerPollers: async () => 0 })).check();
    expect(report.checks.workers.error).toBe('no worker is polling the task queue');
  });

  it('times out a hanging probe instead of hanging itself', async () => {
    const report = await service(probes({ temporal: never })).check();
    expect(report.checks.temporal).toMatchObject({
      status: 'down',
      error: 'no answer within 50ms',
    });
  });
});

describe('health service: caching', () => {
  it('reuses a report within the cache window and refreshes after it', async () => {
    const supplier = vi.fn(ok);
    const clock = { t: 1_000_000 };
    const health = service(probes({ supplier }), clock);

    await health.check();
    await health.check();
    expect(supplier).toHaveBeenCalledTimes(2); // A and B once

    clock.t += 5_001;
    await health.check();
    expect(supplier).toHaveBeenCalledTimes(4);
  });

  it('shares one round of probes between concurrent callers', async () => {
    const redis = vi.fn(ok);
    const health = service(probes({ redis }));
    await Promise.all([health.check(), health.check(), health.check()]);
    expect(redis).toHaveBeenCalledTimes(1);
  });
});

describe('health routes', () => {
  function app(p: HealthProbes) {
    return express().use(createHealthRouter(createHealthController(service(p))));
  }

  it('GET /health answers 200 for degraded', async () => {
    const res = await request(app(probes({ supplier: onlyB(fail('x')) }))).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /health answers 503 for down', async () => {
    const res = await request(app(probes({ workerPollers: async () => 0 }))).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('down');
  });

  it('GET /health/live answers 200 even when dependencies are down', async () => {
    const res = await request(app(probes({ temporal: fail('x'), redis: fail('x') }))).get(
      '/health/live',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
  });
});
