import express, { type Express } from 'express';
import helmet from 'helmet';
import { createHealthController } from './controllers/health.controller';
import { createHotelsController } from './controllers/hotels.controller';
import { errorHandler, notFound } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { createMockSupplierRouter } from './mocks/supplierRouter';
import { createHealthRouter } from './routes/health.routes';
import { createHotelsRouter } from './routes/hotels.routes';
import type { HealthService } from './services/health.service';
import { createHotelOfferService, type HotelOfferServiceDeps } from './services/hotelOffer.service';

export interface AppDeps extends HotelOfferServiceDeps {
  health: HealthService;
  allowChaos: boolean;
}

/** Wires routes → controllers → services from injected clients; no I/O here, so tests can pass fakes. */
export function createApp({ cache, orchestrator, health, allowChaos }: AppDeps): Express {
  const hotelsController = createHotelsController(createHotelOfferService({ cache, orchestrator }));
  const healthController = createHealthController(health);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(helmet());
  app.use(requestContext);

  app.use('/api', createHotelsRouter(hotelsController));
  app.use(createHealthRouter(healthController));
  // Mock suppliers share this process for the assignment; the worker still reaches them over HTTP.
  // Mounted last: their /:supplier/... routes would otherwise claim paths meant for the routers above.
  app.use(createMockSupplierRouter({ allowChaos }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
