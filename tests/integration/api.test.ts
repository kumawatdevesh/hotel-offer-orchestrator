import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { createHotelCache, type HotelCache } from '../../src/cache/hotelCache';
import type { HotelOffer } from '../../src/domain/types';
import { OrchestrationError, type OfferOrchestrator } from '../../src/orchestration/client';
import type { HotelOffersResult } from '../../src/orchestration/shared';
import type { HealthService } from '../../src/services/health.service';

// Real Redis, fake orchestrator: the workflow has its own tests; here we test the HTTP decisions.
const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15');
let clock = 1_700_000_000_000;
const cache = createHotelCache(redis, {
  freshTtlSeconds: 600,
  hardTtlSeconds: 86_400,
  now: () => clock,
});

function offer(name: string, price: number, supplier: HotelOffer['supplier'] = 'supplierA') {
  return { name, city: 'delhi', price, commissionPct: 10, supplier };
}

const DELHI: HotelOffer[] = [
  offer('Lemon Tree', 3200),
  offer('Holtin', 5340, 'supplierB'),
  offer('Radison', 5900, 'supplierB'),
  offer('Leela', 7000, 'supplierB'),
  offer('Taj', 8000),
];

const fresh = (overrides: Partial<HotelOffersResult> = {}): HotelOffersResult => ({
  offers: DELHI,
  degraded: [],
  fetchedAt: clock,
  cached: true,
  ...overrides,
});

const fetchOffers = vi.fn<OfferOrchestrator['fetchOffers']>();
// /health has its own tests; here it only needs to exist.
const health: HealthService = {
  check: async () => {
    throw new Error('not used in these tests');
  },
};
const app = (c: HotelCache = cache) =>
  createApp({
    cache: c,
    orchestrator: { fetchOffers },
    health,
    serveMockSuppliers: true,
    allowChaos: true,
  });

const names = (body: HotelOffer[]) => body.map((o) => o.name);

beforeAll(async () => {
  await redis.ping();
});

beforeEach(async () => {
  await redis.flushdb();
  clock = 1_700_000_000_000;
  fetchOffers.mockReset();
});

afterAll(async () => {
  await redis.quit();
});

describe('GET /api/hotels: validation', () => {
  it.each([
    ['', 'city'],
    ['?city=', 'city'],
    ['?city=delhi&minPrice=abc', 'minPrice'],
    ['?city=delhi&minPrice=-1', 'minPrice'],
    ['?city=delhi&minPrice=9000&maxPrice=1000', 'minPrice must be <= maxPrice'],
    ['?city=a&city=b', 'city'],
  ])('rejects %s', async (qs, expected) => {
    const res = await request(app()).get(`/api/hotels${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_QUERY');
    expect(res.body.error.message).toContain(expected);
    expect(fetchOffers).not.toHaveBeenCalled();
  });

  it('treats an empty minPrice as not given', async () => {
    await cache.save('delhi', DELHI, []);
    const res = await request(app()).get('/api/hotels?city=delhi&minPrice=&maxPrice=5000');
    expect(names(res.body)).toEqual(['Lemon Tree']);
  });
});

describe('GET /api/hotels?city= (no filter)', () => {
  it('fetches fresh offers from the suppliers', async () => {
    fetchOffers.mockResolvedValue(fresh());
    const res = await request(app()).get('/api/hotels?city=delhi');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(DELHI);
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.headers['x-degraded-suppliers']).toBeUndefined();
    expect(fetchOffers).toHaveBeenCalledWith('delhi', expect.any(String));
  });

  it('always goes to the suppliers, even with a fresh cache', async () => {
    await cache.save('delhi', DELHI, []);
    fetchOffers.mockResolvedValue(fresh());
    await request(app()).get('/api/hotels?city=delhi');
    expect(fetchOffers).toHaveBeenCalledOnce();
  });

  it('flags a degraded supplier', async () => {
    fetchOffers.mockResolvedValue(fresh({ degraded: ['supplierB'] }));
    const res = await request(app()).get('/api/hotels?city=delhi');
    expect(res.status).toBe(200);
    expect(res.headers['x-degraded-suppliers']).toBe('supplierB');
  });
});

describe('GET /api/hotels?city=&minPrice=&maxPrice= (filter)', () => {
  it('answers from a fresh cache without calling suppliers', async () => {
    await cache.save('delhi', DELHI, []);
    const res = await request(app()).get('/api/hotels?city=delhi&minPrice=5000&maxPrice=6000');

    expect(names(res.body)).toEqual(['Holtin', 'Radison']);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(fetchOffers).not.toHaveBeenCalled();
  });

  it('keeps the degraded flag recorded with the cached data', async () => {
    await cache.save('delhi', DELHI, ['supplierB']);
    const res = await request(app()).get('/api/hotels?city=delhi&maxPrice=6000');
    expect(res.headers['x-degraded-suppliers']).toBe('supplierB');
  });

  it('fetches first when the city is not cached, then filters', async () => {
    fetchOffers.mockResolvedValue(fresh());
    const res = await request(app()).get('/api/hotels?city=delhi&minPrice=5340&maxPrice=7000');

    expect(names(res.body)).toEqual(['Holtin', 'Radison', 'Leela']);
    expect(res.headers['x-cache']).toBe('MISS');
  });

  it('refreshes when the cached city is stale', async () => {
    await cache.save('delhi', DELHI, []);
    clock += 601_000;
    fetchOffers.mockResolvedValue(fresh());
    const res = await request(app()).get('/api/hotels?city=delhi&maxPrice=4000');

    expect(fetchOffers).toHaveBeenCalledOnce();
    expect(res.headers['x-cache']).toBe('MISS');
  });
});

describe('GET /api/hotels: when fresh data is unavailable', () => {
  it.each(['ALL_SUPPLIERS_FAILED', 'TIMEOUT', 'UNAVAILABLE'] as const)(
    'serves stale cache on %s',
    async (code) => {
      await cache.save('delhi', DELHI, []);
      clock += 3_600_000;
      fetchOffers.mockRejectedValue(new OrchestrationError(code, 'nope'));
      const res = await request(app()).get('/api/hotels?city=delhi');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(DELHI);
      expect(res.headers['x-cache']).toBe('STALE');
      expect(res.headers['x-degraded-suppliers']).toBe('supplierA,supplierB');
    },
  );

  it('applies the price filter to stale data too', async () => {
    await cache.save('delhi', DELHI, []);
    clock += 3_600_000;
    fetchOffers.mockRejectedValue(new OrchestrationError('ALL_SUPPLIERS_FAILED', 'nope'));
    const res = await request(app()).get('/api/hotels?city=delhi&minPrice=7000');

    expect(names(res.body)).toEqual(['Leela', 'Taj']);
    expect(res.headers['x-cache']).toBe('STALE');
  });

  it('returns 503 when suppliers fail and nothing is cached', async () => {
    fetchOffers.mockRejectedValue(new OrchestrationError('ALL_SUPPLIERS_FAILED', 'nope'));
    const res = await request(app()).get('/api/hotels?city=delhi');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ALL_SUPPLIERS_UNAVAILABLE');
    expect(res.headers['x-degraded-suppliers']).toBe('supplierA,supplierB');
  });

  it('keeps working on fresh data when Redis reads fail', async () => {
    const brokenCache: HotelCache = {
      save: async () => undefined,
      getByPriceRange: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    fetchOffers.mockResolvedValue(fresh());
    const res = await request(app(brokenCache)).get('/api/hotels?city=delhi&maxPrice=6000');

    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(['Lemon Tree', 'Holtin', 'Radison']);
  });

  it('returns 500 for unexpected errors without leaking details', async () => {
    fetchOffers.mockRejectedValue(new Error('secret stack detail'));
    const res = await request(app()).get('/api/hotels?city=delhi');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'internal server error' } });
  });
});

describe('cross-cutting', () => {
  it('echoes a caller-supplied request id and passes it to the workflow', async () => {
    fetchOffers.mockResolvedValue(fresh());
    const res = await request(app()).get('/api/hotels?city=delhi').set('x-request-id', 'abc-123');

    expect(res.headers['x-request-id']).toBe('abc-123');
    expect(fetchOffers).toHaveBeenCalledWith('delhi', 'abc-123');
  });

  it('mints a request id when none is sent', async () => {
    fetchOffers.mockResolvedValue(fresh());
    const res = await request(app()).get('/api/hotels?city=delhi');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await request(app()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('serves the mock suppliers from the same app', async () => {
    const res = await request(app()).get('/supplierA/hotels?city=delhi');
    expect(res.status).toBe(200);
  });
});
