import { WorkflowFailedError, type Client } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { hotelKey } from '../domain/selectBestOffers';
import { ALL_SUPPLIERS_FAILED, type HotelOffersResult } from './shared';

export type OrchestrationFailure = 'ALL_SUPPLIERS_FAILED' | 'TIMEOUT' | 'UNAVAILABLE';

/** Any reason we could not get fresh offers; the API answers all of them from cache if it can. */
export class OrchestrationError extends Error {
  constructor(
    readonly code: OrchestrationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'OrchestrationError';
  }
}

export interface OrchestratorOptions {
  client: Client;
  taskQueue: string;
  supplierTimeoutMs: number;
  /** Total time the caller is willing to wait, including Temporal itself being slow or down. */
  timeoutMs: number;
}

export function createOfferOrchestrator(options: OrchestratorOptions) {
  // Single flight inside this process: concurrent requests for one city share one Temporal call.
  // Temporal's workflow-id policy (see startAndWait) does the same across processes.
  const inFlight = new Map<string, Promise<HotelOffersResult>>();

  return {
    fetchOffers(city: string, requestId?: string): Promise<HotelOffersResult> {
      const key = hotelKey(city);
      const existing = inFlight.get(key);
      if (existing) return existing;

      const call = fetchOnce(options, key, requestId).finally(() => inFlight.delete(key));
      inFlight.set(key, call);
      return call;
    },
  };
}

/** One Temporal round trip for a city, bounded by the caller's timeout, with errors mapped. */
async function fetchOnce(
  options: OrchestratorOptions,
  key: string,
  requestId?: string,
): Promise<HotelOffersResult> {
  try {
    return await withTimeout(startAndWait(options, key, requestId), options.timeoutMs, key);
  } catch (err) {
    throw toOrchestrationError(err);
  }
}

async function startAndWait(
  { client, taskQueue, supplierTimeoutMs, timeoutMs }: OrchestratorOptions,
  key: string,
  requestId?: string,
): Promise<HotelOffersResult> {
  const handle = await client.workflow.start('getHotelOffersWorkflow', {
    taskQueue,
    args: [{ city: key, supplierTimeoutMs }],
    // One run per city at a time: concurrent requests for "delhi" join the running workflow
    // instead of each hitting the suppliers.
    workflowId: `hotels-${key}`,
    workflowIdConflictPolicy: 'USE_EXISTING',
    workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    workflowExecutionTimeout: timeoutMs,
    // Visible in the Temporal UI, so a slow request can be traced to its workflow run.
    ...(requestId && { memo: { requestId } }),
  });
  return (await handle.result()) as HotelOffersResult;
}

/** Rejects with TIMEOUT if `work` has not settled within `ms`, even when Temporal itself hangs. */
async function withTimeout<T>(work: Promise<T>, ms: number, key: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OrchestrationError('TIMEOUT', `no result for ${key} in ${ms}ms`)),
      ms,
    );
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    // The losing promise may still reject later; it must not surface as unhandled.
    work.catch(() => undefined);
  }
}

function toOrchestrationError(err: unknown): OrchestrationError {
  if (err instanceof OrchestrationError) return err;
  if (err instanceof WorkflowFailedError) {
    if (err.cause instanceof ApplicationFailure && err.cause.type === ALL_SUPPLIERS_FAILED) {
      return new OrchestrationError('ALL_SUPPLIERS_FAILED', err.cause.message);
    }
    return new OrchestrationError('TIMEOUT', err.cause?.message ?? err.message);
  }
  return new OrchestrationError('UNAVAILABLE', `temporal unavailable: ${String(err)}`);
}

export type OfferOrchestrator = ReturnType<typeof createOfferOrchestrator>;
