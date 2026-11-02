import { Router } from 'express';
import type { HotelsController } from '../controllers/hotels.controller';
import { asyncHandler } from '../middleware/asyncHandler';

export function createHotelsRouter(controller: HotelsController): Router {
  const router = Router();
  router.get('/hotels', asyncHandler(controller.list));
  return router;
}
