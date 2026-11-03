import express from 'express';
import { config } from './config/env';
import { logger } from './config/logger';
import { createMockSupplierRouter } from './mocks/supplierRouter';

/**
 * Mock suppliers as their own process (the `mock-suppliers` container in docker-compose).
 * Standing in for a third party, so they live outside the API and the API, worker and
 * health probes all reach them over the network, like real suppliers.
 * Fault injection stays on: this process only exists for demos and tests.
 */
const app = express();
app.disable('x-powered-by');
app.get('/health/live', (_req, res) => {
  res.json({ status: 'alive' });
});
app.use(createMockSupplierRouter({ allowChaos: true }));

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'mock suppliers listening');
});
server.on('error', (err) => {
  logger.fatal({ err, port: config.PORT }, 'mock suppliers failed to start');
  process.exit(1);
});

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

function stop(signal: string): void {
  logger.info({ signal }, 'mock suppliers stopping');
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
