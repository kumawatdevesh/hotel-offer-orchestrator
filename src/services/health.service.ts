import { SUPPLIERS, type SupplierName } from '../domain/types';
import type { CircuitState } from '../suppliers/circuitBreaker';
import { withTimeout } from '../utils/withTimeout';

/** One function per dependency; each resolves when it is healthy and rejects when it is not. */
export interface HealthProbes {
  redis(): Promise<void>;
  temporal(): Promise<void>;
  /** Workers that polled our task queue recently; 0 means no one will run workflows. */
  workerPollers(): Promise<number>;
  supplier(supplier: SupplierName): Promise<void>;
  circuit(supplier: SupplierName): Promise<CircuitState>;
}

export type OverallStatus = 'ok' | 'degraded' | 'down';

export interface CheckResult {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface SupplierHealth extends CheckResult {
  circuit: CircuitState['state'] | 'unknown';
  retryInMs?: number;
}

export interface HealthReport {
  status: OverallStatus;
  checkedAt: string;
  uptimeSeconds: number;
  checks: {
    redis: CheckResult;
    temporal: CheckResult;
    workers: CheckResult & { pollers: number };
    suppliers: Record<SupplierName, SupplierHealth>;
  };
}

export interface HealthServiceOptions {
  probes: HealthProbes;
  /** Each probe gets at most this long, so /health itself never hangs. */
  probeTimeoutMs: number;
  /** Reports are reused for this long, so frequent health checks don't flood the suppliers. */
  cacheMs: number;
  now?: () => number;
  startedAt?: number;
}

interface CachedReport {
  at: number;
  report: Promise<HealthReport>;
}

/**
 * ok       everything up
 * degraded still serving fresh data, but something is missing: a supplier is down or its
 *          circuit is open, or Redis is down (no cache, no stale fallback)
 * down     fresh data is impossible: Temporal unreachable, no worker running, or every supplier down
 */
export function createHealthService({
  probes,
  probeTimeoutMs,
  cacheMs,
  now = Date.now,
  startedAt = Date.now(),
}: HealthServiceOptions) {
  const state: { cached?: CachedReport } = {};

  return {
    check(): Promise<HealthReport> {
      const at = now();
      if (state.cached && at - state.cached.at < cacheMs) return state.cached.report;

      // Caching the promise also makes concurrent callers share one round of probes.
      const report = buildReport(probes, probeTimeoutMs, startedAt, now);
      state.cached = { at, report };
      return report;
    },
  };
}

async function buildReport(
  probes: HealthProbes,
  timeoutMs: number,
  startedAt: number,
  now: () => number,
): Promise<HealthReport> {
  const [redis, temporal, workers, supplierList] = await Promise.all([
    timed(probes.redis(), timeoutMs),
    timed(probes.temporal(), timeoutMs),
    checkWorkers(probes, timeoutMs),
    Promise.all(SUPPLIERS.map((s) => checkSupplier(probes, s, timeoutMs))),
  ]);

  const suppliers = Object.fromEntries(SUPPLIERS.map((s, i) => [s, supplierList[i]])) as Record<
    SupplierName,
    SupplierHealth
  >;

  return {
    status: overallStatus(redis, temporal, workers, supplierList),
    checkedAt: new Date(now()).toISOString(),
    uptimeSeconds: Math.round((now() - startedAt) / 1_000),
    checks: { redis, temporal, workers, suppliers },
  };
}

function overallStatus(
  redis: CheckResult,
  temporal: CheckResult,
  workers: CheckResult,
  suppliers: SupplierHealth[],
): OverallStatus {
  const anySupplierUp = suppliers.some((s) => s.status === 'up' && s.circuit !== 'open');
  if (temporal.status === 'down' || workers.status === 'down' || !anySupplierUp) return 'down';

  const supplierProblem = suppliers.some((s) => s.status === 'down' || s.circuit === 'open');
  if (redis.status === 'down' || supplierProblem) return 'degraded';

  return 'ok';
}

async function checkWorkers(
  probes: HealthProbes,
  timeoutMs: number,
): Promise<CheckResult & { pollers: number }> {
  const started = performance.now();
  try {
    const pollers = await withTimeout(probes.workerPollers(), timeoutMs, () =>
      timeoutError(timeoutMs),
    );
    const latencyMs = elapsed(started);
    return pollers > 0
      ? { status: 'up', latencyMs, pollers }
      : { status: 'down', latencyMs, pollers, error: 'no worker is polling the task queue' };
  } catch (err) {
    return { status: 'down', latencyMs: elapsed(started), pollers: 0, error: messageOf(err) };
  }
}

async function checkSupplier(
  probes: HealthProbes,
  supplier: SupplierName,
  timeoutMs: number,
): Promise<SupplierHealth> {
  const [reachable, circuit] = await Promise.all([
    timed(probes.supplier(supplier), timeoutMs),
    readCircuit(probes, supplier, timeoutMs),
  ]);
  return { ...reachable, ...circuit };
}

/** Circuit state lives in Redis; if Redis can't answer we say so instead of failing the report. */
async function readCircuit(
  probes: HealthProbes,
  supplier: SupplierName,
  timeoutMs: number,
): Promise<Pick<SupplierHealth, 'circuit' | 'retryInMs'>> {
  try {
    const state = await withTimeout(probes.circuit(supplier), timeoutMs, () =>
      timeoutError(timeoutMs),
    );
    return state.retryInMs === undefined
      ? { circuit: state.state }
      : { circuit: state.state, retryInMs: state.retryInMs };
  } catch {
    return { circuit: 'unknown' };
  }
}

/** Runs one probe with a deadline and turns the outcome into up/down plus how long it took. */
async function timed(probe: Promise<unknown>, timeoutMs: number): Promise<CheckResult> {
  const started = performance.now();
  try {
    await withTimeout(probe, timeoutMs, () => timeoutError(timeoutMs));
    return { status: 'up', latencyMs: elapsed(started) };
  } catch (err) {
    return { status: 'down', latencyMs: elapsed(started), error: messageOf(err) };
  }
}

function timeoutError(ms: number): Error {
  return new Error(`no answer within ${ms}ms`);
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type HealthService = ReturnType<typeof createHealthService>;
