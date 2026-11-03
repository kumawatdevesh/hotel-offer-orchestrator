import { Router } from 'express';
import type { HealthController } from '../controllers/health.controller';
import { asyncHandler } from '../middleware/asyncHandler';

export function createHealthRouter(controller: HealthController): Router {
  const router = Router();
  router.get('/health', asyncHandler(controller.check));
  router.get('/health/live', controller.live);
  return router;
}
