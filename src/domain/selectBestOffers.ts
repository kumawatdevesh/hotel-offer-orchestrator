import type { HotelOffer, SupplierResult } from './types';

// Pure and deterministic: this runs inside the Temporal workflow, so no I/O, clocks or logging.
// Supplier payloads are validated at the HTTP boundary; this function trusts its input.

/** "  The  Taj " → "the taj". Two suppliers' names match when their keys are equal. */
export function hotelKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Rounds to paise so 5900.004 and 5900 compare as equal. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/** True when `candidate` should replace `current`: cheaper, then higher commission, then supplier name. */
function isBetter(candidate: HotelOffer, current: HotelOffer): boolean {
  if (candidate.price !== current.price) return candidate.price < current.price;
  if (candidate.commissionPct !== current.commissionPct) {
    return candidate.commissionPct > current.commissionPct;
  }
  return candidate.supplier < current.supplier;
}

/** Keeps the best offer per hotel name across all suppliers, sorted by price ascending. */
export function selectBestOffers(results: SupplierResult[]): HotelOffer[] {
  const best = new Map<string, HotelOffer>();

  for (const { supplier, hotels } of results) {
    for (const { name, city, price, commissionPct } of hotels) {
      const offer: HotelOffer = {
        name: name.trim().replace(/\s+/g, ' '),
        city,
        price: money(price),
        commissionPct,
        supplier,
      };
      const key = hotelKey(name);
      const current = best.get(key);
      if (!current || isBetter(offer, current)) best.set(key, offer);
    }
  }

  return [...best.values()].sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
}
