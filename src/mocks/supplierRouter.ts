import express, { Router } from 'express';
import { z } from 'zod';
import { SUPPLIERS, type SupplierName } from '../domain/types';
import { MALFORMED_ROWS, MOCK_INVENTORY } from './supplierData';

export const CHAOS_MODES = ['ok', 'fail', 'slow', 'bad-data'] as const;
export type ChaosMode = (typeof CHAOS_MODES)[number];

export interface MockSupplierOptions {
  /** Exposes POST /:supplier/_chaos. Never enable in production. */
  allowChaos: boolean;
  /** How long `slow` mode stalls; longer than the client timeout by default. */
  slowMs?: number;
}

const chaosBody = z.object({ mode: z.enum(CHAOS_MODES) });

/**
 * Mounts GET /supplierA/hotels and GET /supplierB/hotels.
 * Chaos state lives in this closure: the worker reaches these routes over HTTP,
 * so the API process is the only place that needs to know the mode.
 */
export function createMockSupplierRouter({
  allowChaos,
  slowMs = 5_000,
}: MockSupplierOptions): Router {
  const router = Router();
  const modes = new Map<SupplierName, ChaosMode>(SUPPLIERS.map((s) => [s, 'ok']));

  for (const supplier of SUPPLIERS) {
    router.get(`/${supplier}/hotels`, async (req, res) => {
      const city = typeof req.query.city === 'string' ? req.query.city.trim().toLowerCase() : '';
      if (!city) {
        res.status(400).json({ error: { code: 'CITY_REQUIRED', message: 'city is required' } });
        return;
      }

      const mode = modes.get(supplier);
      if (mode === 'fail') {
        res.status(500).json({ error: { code: 'SUPPLIER_DOWN', message: `${supplier} failed` } });
        return;
      }
      if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, slowMs));

      const hotels = MOCK_INVENTORY[supplier][city] ?? [];
      res.json(mode === 'bad-data' ? [...hotels, ...MALFORMED_ROWS] : hotels);
    });

    if (!allowChaos) continue;

    router.get(`/${supplier}/_chaos`, (_req, res) => {
      res.json({ supplier, mode: modes.get(supplier) });
    });

    router.post(`/${supplier}/_chaos`, express.json(), (req, res) => {
      const parsed = chaosBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: 'INVALID_MODE', message: `mode must be one of ${CHAOS_MODES.join(', ')}` },
        });
        return;
      }
      modes.set(supplier, parsed.data.mode);
      res.json({ supplier, mode: parsed.data.mode });
    });
  }

  return router;
}
