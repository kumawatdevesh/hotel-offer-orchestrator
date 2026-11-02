import type Redis from 'ioredis';
import type { Result } from 'ioredis';
import type { Logger } from 'pino';
import type { SupplierName } from '../domain/types';

declare module 'ioredis' {
  interface RedisCommander<Context> {
    recordSupplierFailure(
      failuresKey: string,
      openKey: string,
      resetWindowMs: number,
      threshold: number,
      openMs: number,
    ): Result<number, Context>;
  }
}

// Counts a failure and opens the circuit once the count reaches the threshold, in one atomic step.
// The count's expiry slides with every failure and a success deletes it, so it means
// "failures in a row, with no long quiet gap".
const RECORD_FAILURE_LUA = `
local failures = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
if failures >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
end
return failures
`;

export interface CircuitState {
  state: 'closed' | 'open';
  consecutiveFailures: number;
  /** While open: how long until a trial call is allowed again. */
  retryInMs?: number;
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  openMs: number;
  /** Must be longer than openMs, so a failed trial call re-opens the circuit immediately. */
  resetWindowMs: number;
  log: Logger;
}

function keys(supplier: SupplierName) {
  return { failures: `circuit:{${supplier}}:failures`, open: `circuit:{${supplier}}:open` };
}

/**
 * Stops calling a supplier that keeps failing, so requests stop paying its timeout.
 *
 *   closed ── N failures in a row ──▶ open (supplier skipped for openMs)
 *     ▲                                 │ openMs passes
 *     └──── trial call succeeds ◀── trial call ── fails ──▶ open again
 *
 * State lives in Redis so every worker shares it and /health can read it.
 * If Redis is unreachable the breaker allows every call: it must never be the reason a supplier is skipped.
 */
export function createCircuitBreaker(
  redis: Redis,
  { failureThreshold, openMs, resetWindowMs, log }: CircuitBreakerOptions,
) {
  redis.defineCommand('recordSupplierFailure', { numberOfKeys: 2, lua: RECORD_FAILURE_LUA });

  return {
    async canCall(supplier: SupplierName): Promise<boolean> {
      try {
        return (await redis.exists(keys(supplier).open)) === 0;
      } catch (err) {
        log.warn({ err, supplier }, 'circuit state unavailable; allowing call');
        return true;
      }
    },

    async recordSuccess(supplier: SupplierName): Promise<void> {
      try {
        await redis.del(keys(supplier).failures);
      } catch (err) {
        log.warn({ err, supplier }, 'could not record supplier success');
      }
    },

    async recordFailure(supplier: SupplierName): Promise<void> {
      const k = keys(supplier);
      try {
        const failures = await redis.recordSupplierFailure(
          k.failures,
          k.open,
          resetWindowMs,
          failureThreshold,
          openMs,
        );
        if (failures >= failureThreshold) {
          log.warn({ supplier, failures, openMs }, 'circuit open: skipping supplier');
        }
      } catch (err) {
        log.warn({ err, supplier }, 'could not record supplier failure');
      }
    },

    async getState(supplier: SupplierName): Promise<CircuitState> {
      const k = keys(supplier);
      const [failures, openTtl] = await Promise.all([redis.get(k.failures), redis.pttl(k.open)]);
      const consecutiveFailures = Number(failures ?? 0);
      return openTtl > 0
        ? { state: 'open', consecutiveFailures, retryInMs: openTtl }
        : { state: 'closed', consecutiveFailures };
    },
  };
}

export type CircuitBreaker = ReturnType<typeof createCircuitBreaker>;
