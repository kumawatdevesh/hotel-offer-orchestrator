import express, { type Express } from 'express';
import helmet from 'helmet';
import type { JsonObject } from 'swagger-ui-express';
import { createHealthController } from './controllers/health.controller';
import { createHotelsController } from './controllers/hotels.controller';
import { errorHandler, notFound } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { createMockSupplierRouter } from './mocks/supplierRouter';
import { createDocsRouter } from './routes/docs.routes';
import { createHealthRouter } from './routes/health.routes';
import { createHotelsRouter } from './routes/hotels.routes';
import type { HealthService } from './services/health.service';
import { createHotelOfferService, type HotelOfferServiceDeps } from './services/hotelOffer.service';

export interface AppDeps extends HotelOfferServiceDeps {
  health: HealthService;
  /** Also serve /supplierA and /supplierB from this process (local dev and tests). */
  serveMockSuppliers: boolean;
  allowChaos: boolean;
  /** OpenAPI spec to serve at /docs; left out, there is no /docs. */
  openApiSpec?: JsonObject;
}

/** Wires routes → controllers → services from injected clients; no I/O here, so tests can pass fakes. */
export function createApp({
  cache,
  orchestrator,
  health,
  serveMockSuppliers,
  allowChaos,
  openApiSpec,
}: AppDeps): Express {
  const hotelsController = createHotelsController(createHotelOfferService({ cache, orchestrator }));
  const healthController = createHealthController(health);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(requestContext);
  // Before the strict helmet below: Swagger UI gets its own, looser security headers.
  if (openApiSpec) app.use('/docs', createDocsRouter(openApiSpec));
  app.use(helmet());

  app.use('/api', createHotelsRouter(hotelsController));
  app.use(createHealthRouter(healthController));
  // Local dev: mock suppliers share this process; the worker still reaches them over HTTP.
  // Mounted last: their /:supplier/... routes would otherwise claim paths meant for the routers above.
  if (serveMockSuppliers) app.use(createMockSupplierRouter({ allowChaos }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
