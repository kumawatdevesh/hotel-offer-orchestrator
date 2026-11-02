import { Router, type Response } from 'express';
import { z } from 'zod';
import type { CachedHotels, HotelCache, PriceRange } from '../cache/hotelCache';
import { SUPPLIERS, type HotelOffer, type SupplierName } from '../domain/types';
import { OrchestrationError, type OfferOrchestrator } from '../temporal/client';
import { asyncHandler } from './middleware';

// `?minPrice=` means "not given", not 0.
const optionalPrice = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.coerce
    .number({ invalid_type_error: 'must be a number' })
    .finite()
    .nonnegative('must be >= 0')
    .optional(),
);

const query = z
  .object({
    city: z
      .string({ required_error: 'city is required' })
      .trim()
      .min(1, 'city is required')
      .max(100),
    minPrice: optionalPrice,
    maxPrice: optionalPrice,
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    message: 'minPrice must be <= maxPrice',
    path: ['minPrice'],
  });

type CacheStatus = 'HIT' | 'MISS' | 'STALE';

interface Answer {
  offers: HotelOffer[];
  cache: CacheStatus;
  degraded: SupplierName[];
  fetchedAt: Date;
}

export interface HotelsRouteDeps {
  cache: HotelCache;
  orchestrator: OfferOrchestrator;
}

/**
 * GET /api/hotels?city=           → always fresh from suppliers (via the workflow), which also refreshes the cache.
 * GET /api/hotels?city=&min&max   → straight from Redis while the cached city is fresh; otherwise refresh first.
 * Either way, if no fresh data can be had, stale cache beats an error; 503 only when there is nothing at all.
 */
export function createHotelsRouter({ cache, orchestrator }: HotelsRouteDeps): Router {
  const router = Router();

  router.get(
    '/hotels',
    asyncHandler(async (req, res) => {
      const parsed = query.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'INVALID_QUERY',
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          },
        });
        return;
      }

      const { city, minPrice, maxPrice } = parsed.data;
      const range: PriceRange = {
        ...(minPrice !== undefined && { min: minPrice }),
        ...(maxPrice !== undefined && { max: maxPrice }),
      };
      const isFilter = minPrice !== undefined || maxPrice !== undefined;

      // Redis being down must not take the endpoint down: treat it as a miss and carry on.
      const readCache = async (): Promise<CachedHotels | null> => {
        try {
          return await cache.getByPriceRange(city, range);
        } catch (err) {
          req.log.warn({ err, city }, 'cache read failed; continuing without cache');
          return null;
        }
      };

      let cached: CachedHotels | null = null;
      if (isFilter) {
        cached = await readCache();
        if (cached?.isFresh) {
          send(res, { ...cached, cache: 'HIT' });
          return;
        }
      }

      try {
        const result = await orchestrator.fetchOffers(city, req.id);
        send(res, {
          offers: isFilter ? result.offers.filter((o) => inRange(o.price, range)) : result.offers,
          cache: 'MISS',
          degraded: result.degraded,
          fetchedAt: new Date(result.fetchedAt),
        });
        return;
      } catch (err) {
        if (!(err instanceof OrchestrationError)) throw err;
        req.log.warn({ code: err.code, city, reason: err.message }, 'fresh fetch failed');
      }

      const stale = cached ?? (await readCache());
      if (stale) {
        // Every supplier is effectively missing from this answer, whatever the cache recorded.
        send(res, { ...stale, cache: 'STALE', degraded: [...SUPPLIERS] });
        return;
      }

      res.setHeader('x-degraded-suppliers', SUPPLIERS.join(','));
      res.status(503).json({
        error: {
          code: 'ALL_SUPPLIERS_UNAVAILABLE',
          message: `no supplier responded and no cached data exists for ${city}`,
        },
      });
    }),
  );

  return router;
}

function inRange(value: number, { min, max }: PriceRange): boolean {
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}

function send(res: Response, { offers, cache, degraded, fetchedAt }: Answer): void {
  res.setHeader('x-cache', cache);
  res.setHeader('x-data-fetched-at', fetchedAt.toISOString());
  if (degraded.length > 0) res.setHeader('x-degraded-suppliers', degraded.join(','));
  res.json(offers);
}
