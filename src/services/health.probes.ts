import type { Client } from '@temporalio/client';
import type Redis from 'ioredis';
import type { SupplierName } from '../domain/types';
import type { CircuitBreaker } from '../suppliers/circuitBreaker';
import { fetchSupplierHotels } from '../suppliers/supplierClient';
import type { HealthProbes } from './health.service';

// Temporal's enum value for workflow task queues (temporal.api.enums.v1.TaskQueueType).
const TASK_QUEUE_TYPE_WORKFLOW = 1;
// Temporal keeps listing a poller for minutes after it stops, so only count recent ones.
// An idle healthy worker re-polls about every 55 s (measured), so 90 s never flags a live
// worker and still notices a dead one within a minute and a half.
const RECENT_POLLER_MS = 90_000;

export interface HealthProbeDeps {
  redis: Redis;
  temporal: Client;
  namespace: string;
  taskQueue: string;
  breaker: CircuitBreaker;
  supplierTimeoutMs: number;
}

/** The real probes behind /health. Read-only: they never change cache or circuit state. */
export function createHealthProbes({
  redis,
  temporal,
  namespace,
  taskQueue,
  breaker,
  supplierTimeoutMs,
}: HealthProbeDeps): HealthProbes {
  return {
    async redis() {
      await redis.ping();
    },

    async temporal() {
      await temporal.workflowService.getSystemInfo({});
    },

    async workerPollers() {
      const { pollers } = await temporal.workflowService.describeTaskQueue({
        namespace,
        taskQueue: { name: taskQueue },
        taskQueueType: TASK_QUEUE_TYPE_WORKFLOW,
      });
      const cutoffSeconds = (Date.now() - RECENT_POLLER_MS) / 1_000;
      return pollers.filter((p) => Number(p.lastAccessTime?.seconds ?? 0) >= cutoffSeconds).length;
    },

    async supplier(supplier: SupplierName) {
      // A real but harmless call: an unknown city returns [] from a healthy supplier.
      await fetchSupplierHotels(supplier, 'healthcheck', { timeoutMs: supplierTimeoutMs });
    },

    circuit(supplier: SupplierName) {
      return breaker.getState(supplier);
    },
  };
}
