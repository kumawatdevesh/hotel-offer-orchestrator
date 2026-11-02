import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cacheKeys, createHotelCache } from '../../src/cache/hotelCache';
import type { HotelOffer } from '../../src/domain/types';

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

const DELHI = [
  offer('Lemon Tree', 3200),
  offer('Holtin', 5340, 'supplierB'),
  offer('Radison', 5900, 'supplierB'),
  offer('Leela', 7000, 'supplierB'),
  offer('Taj', 8000),
];

beforeAll(async () => {
  await redis.ping();
});

beforeEach(async () => {
  await redis.flushdb();
  clock = 1_700_000_000_000;
});

afterAll(async () => {
  await redis.quit();
});

const names = (offers: HotelOffer[] | undefined) => offers?.map((o) => o.name);

describe('hotelCache', () => {
  it('returns null for a city that was never cached', async () => {
    expect(await cache.getByPriceRange('delhi')).toBeNull();
  });

  it('round-trips the full list, cheapest first', async () => {
    await cache.save('delhi', [...DELHI].reverse(), []);
    const result = await cache.getByPriceRange('delhi');
    expect(result?.offers).toEqual(DELHI);
    expect(result).toMatchObject({ degraded: [], isFresh: true });
  });

  it('filters by price with both ends inclusive', async () => {
    await cache.save('delhi', DELHI, []);
    const result = await cache.getByPriceRange('delhi', { min: 5340, max: 7000 });
    expect(names(result?.offers)).toEqual(['Holtin', 'Radison', 'Leela']);
  });

  it('supports only a min or only a max', async () => {
    await cache.save('delhi', DELHI, []);
    expect(names((await cache.getByPriceRange('delhi', { min: 7000 }))?.offers)).toEqual([
      'Leela',
      'Taj',
    ]);
    expect(names((await cache.getByPriceRange('delhi', { max: 3200 }))?.offers)).toEqual([
      'Lemon Tree',
    ]);
  });

  it('returns an empty list, not null, when nothing is in range', async () => {
    await cache.save('delhi', DELHI, []);
    const result = await cache.getByPriceRange('delhi', { min: 100, max: 200 });
    expect(result?.offers).toEqual([]);
  });

  it('caches a city with no hotels as an empty hit', async () => {
    await cache.save('paris', [], []);
    expect((await cache.getByPriceRange('paris'))?.offers).toEqual([]);
  });

  it('replaces the previous list instead of merging into it', async () => {
    await cache.save('delhi', DELHI, []);
    await cache.save('delhi', [offer('Holtin', 5000)], ['supplierB']);
    const result = await cache.getByPriceRange('delhi');
    expect(result?.offers).toEqual([offer('Holtin', 5000)]);
    expect(result?.degraded).toEqual(['supplierB']);
  });

  it('marks data older than the fresh TTL as stale but still returns it', async () => {
    await cache.save('delhi', DELHI, []);
    clock += 601_000;
    const result = await cache.getByPriceRange('delhi');
    expect(result?.isFresh).toBe(false);
    expect(result?.offers).toHaveLength(5);
  });

  it('sets the hard TTL on every key', async () => {
    await cache.save('delhi', DELHI, []);
    const keys = cacheKeys('delhi');
    for (const key of [keys.prices, keys.offers, keys.meta]) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(86_000);
      expect(ttl).toBeLessThanOrEqual(86_400);
    }
  });

  it('treats city names case-insensitively', async () => {
    await cache.save('Delhi ', DELHI, []);
    expect((await cache.getByPriceRange('delhi'))?.offers).toHaveLength(5);
  });

  it('handles more hotels than one Lua unpack chunk', async () => {
    const many = Array.from({ length: 1_200 }, (_, i) => offer(`Hotel ${i}`, 1_000 + i));
    await cache.save('delhi', many, []);
    expect((await cache.getByPriceRange('delhi'))?.offers).toHaveLength(1_200);
  });
});
