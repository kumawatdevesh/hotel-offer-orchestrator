import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { SUPPLIERS, type SupplierName } from '../domain/types';
import { MALFORMED_ROWS, MOCK_INVENTORY } from './supplierData';

export const CHAOS_MODES = ['ok', 'fail', 'slow', 'bad-data'] as const;
export type ChaosMode = (typeof CHAOS_MODES)[number];

export interface MockSupplierOptions {
  /** Exposes GET/POST /:supplier/_chaos. Never enable in production. */
  allowChaos: boolean;
  /** How long `slow` mode stalls; longer than the client timeout by default. */
  slowMs?: number;
}

/** Per-router state, so each router (and each test) starts with every supplier healthy. */
interface MockState {
  modes: Map<SupplierName, ChaosMode>;
  slowMs: number;
}

const chaosBody = z.object({ mode: z.enum(CHAOS_MODES) });

/**
 * Fake supplier endpoints:
 *   GET  /:supplier/hotels?city=   supplier's hotels for a city
 *   GET  /:supplier/_chaos         current fault mode          (only when allowChaos)
 *   POST /:supplier/_chaos         {"mode": "ok|fail|slow|bad-data"}
 * The worker reaches these over HTTP, so the API process is the only place that knows the mode.
 */
export function createMockSupplierRouter({
  allowChaos,
  slowMs = 5_000,
}: MockSupplierOptions): Router {
  const state: MockState = {
    modes: new Map(SUPPLIERS.map((s) => [s, 'ok'])),
    slowMs,
  };

  const router = Router();
  router.get('/:supplier/hotels', (req, res) => getHotels(state, req, res));
  if (allowChaos) {
    router.get('/:supplier/_chaos', (req, res) => getChaos(state, req, res));
    router.post('/:supplier/_chaos', express.json(), (req, res) => setChaos(state, req, res));
  }
  return router;
}

async function getHotels(state: MockState, req: Request, res: Response): Promise<void> {
  const supplier = supplierFrom(req, res);
  if (!supplier) return;

  const city = typeof req.query.city === 'string' ? req.query.city.trim().toLowerCase() : '';
  if (!city) {
    res.status(400).json({ error: { code: 'CITY_REQUIRED', message: 'city is required' } });
    return;
  }

  const mode = state.modes.get(supplier);
  if (mode === 'fail') {
    res.status(500).json({ error: { code: 'SUPPLIER_DOWN', message: `${supplier} failed` } });
    return;
  }
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, state.slowMs));

  const hotels = MOCK_INVENTORY[supplier][city] ?? [];
  res.json(mode === 'bad-data' ? [...hotels, ...MALFORMED_ROWS] : hotels);
}

function getChaos(state: MockState, req: Request, res: Response): void {
  const supplier = supplierFrom(req, res);
  if (!supplier) return;
  res.json({ supplier, mode: state.modes.get(supplier) });
}

function setChaos(state: MockState, req: Request, res: Response): void {
  const supplier = supplierFrom(req, res);
  if (!supplier) return;

  const parsed = chaosBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'INVALID_MODE', message: `mode must be one of ${CHAOS_MODES.join(', ')}` },
    });
    return;
  }
  state.modes.set(supplier, parsed.data.mode);
  res.json({ supplier, mode: parsed.data.mode });
}

/** Reads :supplier from the URL; answers 404 and returns undefined for a name we don't know. */
function supplierFrom(req: Request, res: Response): SupplierName | undefined {
  const name = req.params.supplier;
  const supplier = SUPPLIERS.find((s) => s === name);
  if (!supplier) {
    res
      .status(404)
      .json({ error: { code: 'UNKNOWN_SUPPLIER', message: `no supplier named "${name}"` } });
  }
  return supplier;
}
