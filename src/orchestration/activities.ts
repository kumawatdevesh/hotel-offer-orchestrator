import { ApplicationFailure } from '@temporalio/activity';
import type { HotelCache } from '../cache/hotelCache';
import type { HotelOffer, SupplierHotel, SupplierName } from '../domain/types';
import type { CircuitBreaker } from '../suppliers/circuitBreaker';
import { fetchSupplierHotels, SupplierError } from '../suppliers/supplierClient';

export const SUPPLIER_CIRCUIT_OPEN = 'SUPPLIER_CIRCUIT_OPEN';

export interface ActivityDeps {
  cache: HotelCache;
  breaker: CircuitBreaker;
  /** Injectable so tests can fake the supplier without an HTTP server. */
  fetchHotels?: typeof fetchSupplierHotels;
}

/** Activities do all the I/O; the workflow only decides what to call and in what order. */
export function createActivities({
  cache,
  breaker,
  fetchHotels = fetchSupplierHotels,
}: ActivityDeps) {
  return {
    async fetchSupplier(supplier: SupplierName, city: string): Promise<SupplierHotel[]> {
      if (!(await breaker.canCall(supplier))) {
        // Fail in milliseconds instead of waiting out a timeout we already expect.
        throw ApplicationFailure.create({
          type: SUPPLIER_CIRCUIT_OPEN,
          message: `${supplier} skipped: circuit open after repeated failures`,
          nonRetryable: true,
        });
      }

      try {
        const hotels = await fetchHotels(supplier, city);
        await breaker.recordSuccess(supplier);
        return hotels;
      } catch (err) {
        if (!(err instanceof SupplierError)) throw err;
        // A 4xx means our request was wrong, not that the supplier is unhealthy.
        const supplierAtFault = !(err.reason === 'http' && !err.retryable);
        if (supplierAtFault) await breaker.recordFailure(supplier);

        // Tells Temporal whether another attempt can help (5xx, network) or not (timeout, garbage).
        throw ApplicationFailure.create({
          type: `SUPPLIER_${err.reason.toUpperCase()}`,
          message: err.message,
          nonRetryable: !err.retryable,
        });
      }
    },

    async saveToCache(city: string, offers: HotelOffer[], degraded: SupplierName[]): Promise<void> {
      await cache.save(city, offers, degraded);
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
