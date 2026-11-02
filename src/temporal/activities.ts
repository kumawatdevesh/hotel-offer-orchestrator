import { ApplicationFailure } from '@temporalio/activity';
import type { HotelCache } from '../cache/hotelCache';
import type { HotelOffer, SupplierHotel, SupplierName } from '../domain/types';
import { fetchSupplierHotels, SupplierError } from '../suppliers/supplierClient';

/** Activities do all the I/O; the workflow only decides what to call and in what order. */
export function createActivities(cache: HotelCache) {
  return {
    async fetchSupplier(supplier: SupplierName, city: string): Promise<SupplierHotel[]> {
      try {
        return await fetchSupplierHotels(supplier, city);
      } catch (err) {
        if (!(err instanceof SupplierError)) throw err;
        // Tells Temporal whether another attempt can help (timeout, 5xx) or not (garbage payload).
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
