import pino from 'pino';
import { config } from './env';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'hotel-offer-orchestrator' },
});
