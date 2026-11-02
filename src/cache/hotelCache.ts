import type Redis from 'ioredis';
import type { Result } from 'ioredis';
import { hotelKey } from '../domain/selectBestOffers';
import type { HotelOffer, SupplierName } from '../domain/types';

declare module 'ioredis' {
  interface RedisCommander<Context> {
    hotelsByPrice(
      pricesKey: string,
      offersKey: string,
      metaKey: string,
      min: string,
      max: string,
    ): Result<string[] | null, Context>;
  }
}

// Reads the ZSET range and the matching HASH fields in one atomic step, so a concurrent
// save can never leave us with a name whose offer is already gone.
// Under memory pressure Redis evicts keys one at a time, so a city can lose its ZSET or HASH
// while meta survives; that half-entry is reported as a miss, not as "no hotels".
// HMGET runs in chunks because Lua's unpack() has a stack limit (~8k values).
const HOTELS_BY_PRICE_LUA = `
local meta = redis.call('GET', KEYS[3])
if not meta then return nil end
if cjson.decode(meta).count > 0 and redis.call('EXISTS', KEYS[1], KEYS[2]) < 2 then
  return nil
end
local names = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[2])
local out = { meta }
for i = 1, #names, 500 do
  local chunk = { unpack(names, i, math.min(i + 499, #names)) }
  local offers = redis.call('HMGET', KEYS[2], unpack(chunk))
  for _, offer in ipairs(offers) do
    if offer then out[#out + 1] = offer end
  end
end
return out
`;

interface CacheMeta {
  fetchedAt: number;
  /** Offers written with this meta; 0 means the city legitimately has no ZSET/HASH. */
  count: number;
  degraded: SupplierName[];
}

export interface CachedHotels {
  offers: HotelOffer[];
  fetchedAt: Date;
  degraded: SupplierName[];
  /** False once older than the fresh TTL; such data is only served as a fallback. */
  isFresh: boolean;
}

export interface PriceRange {
  min?: number;
  max?: number;
}

export interface HotelCacheOptions {
  freshTtlSeconds: number;
  hardTtlSeconds: number;
  now?: () => number;
}

/** The `{city}` hash tag keeps all of a city's keys on one Redis Cluster slot, so MULTI and Lua work. */
export function cacheKeys(city: string) {
  const tag = `{${hotelKey(city)}}`;
  return {
    prices: `hotels:${tag}:prices`,
    offers: `hotels:${tag}:offers`,
    meta: `hotels:${tag}:meta`,
  };
}

export function createHotelCache(
  redis: Redis,
  { freshTtlSeconds, hardTtlSeconds, now = Date.now }: HotelCacheOptions,
) {
  // Redefining is harmless; ioredis sends EVALSHA and only falls back to EVAL on a script-cache miss.
  redis.defineCommand('hotelsByPrice', { numberOfKeys: 3, lua: HOTELS_BY_PRICE_LUA });

  return {
    /** Replaces the city's list atomically: readers see the old list or the new one, never a mix. */
    async save(city: string, offers: HotelOffer[], degraded: SupplierName[]): Promise<void> {
      const keys = cacheKeys(city);
      const meta: CacheMeta = { fetchedAt: now(), count: offers.length, degraded };
      const tx = redis.multi().del(keys.prices, keys.offers);

      if (offers.length > 0) {
        tx.zadd(keys.prices, ...offers.flatMap((o) => [o.price, hotelKey(o.name)]));
        tx.hset(
          keys.offers,
          Object.fromEntries(offers.map((o) => [hotelKey(o.name), JSON.stringify(o)])),
        );
        tx.expire(keys.prices, hardTtlSeconds).expire(keys.offers, hardTtlSeconds);
      }
      // Meta is written even for an empty list, so "no hotels in this city" is a cache hit too.
      tx.set(keys.meta, JSON.stringify(meta), 'EX', hardTtlSeconds);

      const results = await tx.exec();
      const failed = results?.find(([err]) => err);
      if (!results || failed) throw failed?.[0] ?? new Error('redis transaction aborted');
    },

    /** Offers with min <= price <= max, cheapest first. Null when the city was never cached or has expired. */
    async getByPriceRange(
      city: string,
      { min, max }: PriceRange = {},
    ): Promise<CachedHotels | null> {
      const keys = cacheKeys(city);
      const rows = await redis.hotelsByPrice(
        keys.prices,
        keys.offers,
        keys.meta,
        min === undefined ? '-inf' : String(min),
        max === undefined ? '+inf' : String(max),
      );
      if (!rows) return null;

      const [metaJson, ...offerJson] = rows;
      const meta = JSON.parse(metaJson as string) as CacheMeta;
      return {
        offers: offerJson.map((json) => JSON.parse(json) as HotelOffer),
        fetchedAt: new Date(meta.fetchedAt),
        degraded: meta.degraded,
        isFresh: now() - meta.fetchedAt < freshTtlSeconds * 1_000,
      };
    },
  };
}

export type HotelCache = ReturnType<typeof createHotelCache>;
