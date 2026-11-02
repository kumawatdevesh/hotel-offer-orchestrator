import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PriceRange } from '../cache/hotelCache';
import {
  OffersUnavailableError,
  type HotelOffersAnswer,
  type HotelOfferService,
} from '../services/hotelOffer.service';

// `?minPrice=` means "not given", not 0.
const optionalPrice = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.coerce
    .number({ invalid_type_error: 'must be a number' })
    .finite()
    .nonnegative('must be >= 0')
    .optional(),
);

const hotelsQuery = z
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

/** HTTP only: parse the query, call the service, turn its answer into status, headers and body. */
export function createHotelsController(service: HotelOfferService) {
  return {
    async list(req: Request, res: Response): Promise<void> {
      const parsed = hotelsQuery.safeParse(req.query);
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

      try {
        const answer = await service.getOffers({ city, range, requestId: req.id, log: req.log });
        send(res, answer);
      } catch (err) {
        if (!(err instanceof OffersUnavailableError)) throw err;
        res.setHeader('x-degraded-suppliers', err.degraded.join(','));
        res
          .status(503)
          .json({ error: { code: 'ALL_SUPPLIERS_UNAVAILABLE', message: err.message } });
      }
    },
  };
}

function send(res: Response, { offers, cache, degraded, fetchedAt }: HotelOffersAnswer): void {
  res.setHeader('x-cache', cache);
  res.setHeader('x-data-fetched-at', fetchedAt.toISOString());
  if (degraded.length > 0) res.setHeader('x-degraded-suppliers', degraded.join(','));
  res.json(offers);
}

export type HotelsController = ReturnType<typeof createHotelsController>;
