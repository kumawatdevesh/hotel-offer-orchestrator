import { z } from 'zod';
import { config } from '../config';
import type { SupplierHotel, SupplierName } from '../domain/types';
import { logger } from '../logger';

export type SupplierFailureReason = 'timeout' | 'network' | 'http' | 'invalid_response';

export class SupplierError extends Error {
  constructor(
    readonly supplier: SupplierName,
    readonly reason: SupplierFailureReason,
    message: string,
    /** False when retrying cannot help, e.g. the supplier sent a payload we can't read. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SupplierError';
  }
}

const hotelRow = z.object({
  hotelId: z.string().min(1),
  name: z.string().trim().min(1),
  city: z.string().trim().min(1),
  price: z.number().finite().positive(),
  commissionPct: z.number().finite().min(0).max(100),
});

const BASE_URLS: Record<SupplierName, string> = {
  supplierA: config.SUPPLIER_A_URL,
  supplierB: config.SUPPLIER_B_URL,
};

export interface FetchOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Calls one supplier and returns only the rows that pass validation.
 * Throws SupplierError on timeout, network error, non-2xx, or a body that is not an array.
 */
export async function fetchSupplierHotels(
  supplier: SupplierName,
  city: string,
  { baseUrl = BASE_URLS[supplier], timeoutMs = config.SUPPLIER_TIMEOUT_MS }: FetchOptions = {},
): Promise<SupplierHotel[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/hotels?city=${encodeURIComponent(city)}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      // Not retried: a supplier that just used the whole budget will likely do it again,
      // and a retry would double the user's wait. Fast failures below do get a retry.
      throw new SupplierError(
        supplier,
        'timeout',
        `${supplier} timed out after ${timeoutMs}ms`,
        false,
      );
    }
    throw new SupplierError(supplier, 'network', `${supplier} unreachable: ${String(err)}`, true);
  }

  if (!response.ok) {
    // 5xx and 429 are worth another try; other 4xx mean our request is wrong.
    const retryable = response.status >= 500 || response.status === 429;
    throw new SupplierError(supplier, 'http', `${supplier} returned ${response.status}`, retryable);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SupplierError(supplier, 'invalid_response', `${supplier} sent invalid JSON`, false);
  }
  if (!Array.isArray(body)) {
    throw new SupplierError(supplier, 'invalid_response', `${supplier} did not send a list`, false);
  }

  const hotels: SupplierHotel[] = [];
  for (const row of body) {
    const parsed = hotelRow.safeParse(row);
    if (parsed.success) {
      hotels.push(parsed.data);
      continue;
    }
    // One bad row should cost us that row, not the whole supplier.
    logger.warn(
      {
        supplier,
        city,
        row,
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      'dropped malformed supplier row',
    );
  }
  return hotels;
}
