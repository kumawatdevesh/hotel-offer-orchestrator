import { ApplicationFailure, log, proxyActivities } from '@temporalio/workflow';
import { selectBestOffers } from '../domain/selectBestOffers';
import { SUPPLIERS, type SupplierName } from '../domain/types';
import type { Activities } from './activities';
import { ALL_SUPPLIERS_FAILED, type HotelOffersInput, type HotelOffersResult } from './shared';

// Workflow code is replayed from history, so it must stay deterministic:
// no network, no process.env, no logger other than the replay-safe `log`.

export async function getHotelOffersWorkflow({
  city,
  supplierTimeoutMs,
}: HotelOffersInput): Promise<HotelOffersResult> {
  const { fetchSupplier } = proxyActivities<Activities>({
    startToCloseTimeout: supplierTimeoutMs + 1_000,
    // One retry: a user is waiting, so two short attempts beat many slow ones.
    retry: { maximumAttempts: 2, initialInterval: '200ms', backoffCoefficient: 2 },
  });
  const { saveToCache } = proxyActivities<Activities>({
    startToCloseTimeout: '2s',
    retry: { maximumAttempts: 3, initialInterval: '100ms' },
  });

  // allSettled: one supplier failing must not cancel or hide the other's answer.
  const settled = await Promise.allSettled(SUPPLIERS.map((s) => fetchSupplier(s, city)));

  const results = [];
  const degraded: SupplierName[] = [];
  for (const [i, outcome] of settled.entries()) {
    const supplier = SUPPLIERS[i] as SupplierName;
    if (outcome.status === 'fulfilled') {
      results.push({ supplier, hotels: outcome.value });
    } else {
      degraded.push(supplier);
      log.warn('supplier failed', { supplier, city, error: String(outcome.reason) });
    }
  }

  if (results.length === 0) {
    throw ApplicationFailure.create({
      type: ALL_SUPPLIERS_FAILED,
      message: `all suppliers failed for ${city}`,
      nonRetryable: true,
      details: [degraded],
    });
  }

  const offers = selectBestOffers(results);

  // A cache outage costs us speed later, not this answer.
  let cached = true;
  try {
    await saveToCache(city, offers, degraded);
  } catch (err) {
    cached = false;
    log.error('cache save failed', { city, error: String(err) });
  }

  return { offers, degraded, fetchedAt: Date.now(), cached };
}
