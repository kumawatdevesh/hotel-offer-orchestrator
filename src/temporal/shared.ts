import type { HotelOffer, SupplierName } from '../domain/types';

// Shared by the workflow (sandboxed) and the API-side client, so it must import nothing at runtime.

export const ALL_SUPPLIERS_FAILED = 'ALL_SUPPLIERS_FAILED';

export interface HotelOffersInput {
  city: string;
  /** Per-attempt HTTP timeout the activity enforces; the activity timeout sits just above it. */
  supplierTimeoutMs: number;
}

export interface HotelOffersResult {
  offers: HotelOffer[];
  degraded: SupplierName[];
  fetchedAt: number;
  /** False when the result could not be written to Redis; the answer itself is still good. */
  cached: boolean;
}
