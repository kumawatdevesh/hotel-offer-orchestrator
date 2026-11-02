import express, { type Express } from 'express';
import helmet from 'helmet';
import { createMockSupplierRouter } from '../suppliers/mockRouter';
import { createHotelsRouter, type HotelsRouteDeps } from './hotelsRoute';
import { errorHandler, notFound, requestContext } from './middleware';

export interface AppDeps extends HotelsRouteDeps {
  allowChaos: boolean;
}

/** Builds the Express app from its dependencies; no I/O here, so tests can pass fakes. */
export function createApp({ cache, orchestrator, allowChaos }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(helmet());
  app.use(requestContext);

  app.use('/api', createHotelsRouter({ cache, orchestrator }));
  // Mock suppliers share this process for the assignment; the worker still reaches them over HTTP.
  app.use(createMockSupplierRouter({ allowChaos }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
