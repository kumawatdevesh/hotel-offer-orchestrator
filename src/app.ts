import express, { type Express } from 'express';
import helmet from 'helmet';
import { createHotelsController } from './controllers/hotels.controller';
import { errorHandler, notFound } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { createMockSupplierRouter } from './mocks/supplierRouter';
import { createHotelsRouter } from './routes/hotels.routes';
import { createHotelOfferService, type HotelOfferServiceDeps } from './services/hotelOffer.service';

export interface AppDeps extends HotelOfferServiceDeps {
  allowChaos: boolean;
}

/** Wires routes → controllers → services from injected clients; no I/O here, so tests can pass fakes. */
export function createApp({ cache, orchestrator, allowChaos }: AppDeps): Express {
  const hotelsController = createHotelsController(createHotelOfferService({ cache, orchestrator }));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(helmet());
  app.use(requestContext);

  app.use('/api', createHotelsRouter(hotelsController));
  // Mock suppliers share this process for the assignment; the worker still reaches them over HTTP.
  app.use(createMockSupplierRouter({ allowChaos }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
