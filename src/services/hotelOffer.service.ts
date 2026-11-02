import type { Logger } from 'pino';
import type { CachedHotels, HotelCache, PriceRange } from '../cache/hotelCache';
import { SUPPLIERS, type HotelOffer, type SupplierName } from '../domain/types';
import { OrchestrationError, type OfferOrchestrator } from '../orchestration/client';

export type CacheStatus = 'HIT' | 'MISS' | 'STALE';

export interface HotelOffersAnswer {
  offers: HotelOffer[];
  cache: CacheStatus;
  degraded: SupplierName[];
  fetchedAt: Date;
}

export interface GetOffersInput {
  city: string;
  range: PriceRange;
  requestId: string;
  log: Logger;
}

/** No supplier answered and nothing is cached: the only case the API turns into an error. */
export class OffersUnavailableError extends Error {
  readonly degraded: SupplierName[] = [...SUPPLIERS];

  constructor(readonly city: string) {
    super(`no supplier responded and no cached data exists for ${city}`);
    this.name = 'OffersUnavailableError';
  }
}

export interface HotelOfferServiceDeps {
  cache: HotelCache;
  orchestrator: OfferOrchestrator;
}

/**
 * No price range → always fresh from suppliers (via the workflow), which also refreshes the cache.
 * Price range    → straight from Redis while the cached city is fresh; otherwise refresh first.
 * Either way, if no fresh data can be had, stale cache beats an error.
 */
export function createHotelOfferService({ cache, orchestrator }: HotelOfferServiceDeps) {
  return {
    async getOffers({ city, range, requestId, log }: GetOffersInput): Promise<HotelOffersAnswer> {
      const isFilter = range.min !== undefined || range.max !== undefined;

      // Redis being down must not take the endpoint down: treat it as a miss and carry on.
      const readCache = async (): Promise<CachedHotels | null> => {
        try {
          return await cache.getByPriceRange(city, range);
        } catch (err) {
          log.warn({ err, city }, 'cache read failed; continuing without cache');
          return null;
        }
      };

      let cached: CachedHotels | null = null;
      if (isFilter) {
        cached = await readCache();
        if (cached?.isFresh) return { ...cached, cache: 'HIT' };
      }

      try {
        const result = await orchestrator.fetchOffers(city, requestId);
        return {
          offers: isFilter ? result.offers.filter((o) => inRange(o.price, range)) : result.offers,
          cache: 'MISS',
          degraded: result.degraded,
          fetchedAt: new Date(result.fetchedAt),
        };
      } catch (err) {
        if (!(err instanceof OrchestrationError)) throw err;
        log.warn({ code: err.code, city, reason: err.message }, 'fresh fetch failed');
      }

      const stale = cached ?? (await readCache());
      // Every supplier is effectively missing from a stale answer, whatever the cache recorded.
      if (stale) return { ...stale, cache: 'STALE', degraded: [...SUPPLIERS] };

      throw new OffersUnavailableError(city);
    },
  };
}

function inRange(value: number, { min, max }: PriceRange): boolean {
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}

export type HotelOfferService = ReturnType<typeof createHotelOfferService>;
