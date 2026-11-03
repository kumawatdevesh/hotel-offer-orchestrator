import type { Request, Response } from 'express';
import type { HealthService } from '../services/health.service';

export function createHealthController(service: HealthService) {
  return {
    /** Liveness: the process is up and serving HTTP. Cheap; for Docker/Kubernetes restarts. */
    live(_req: Request, res: Response): void {
      res.json({ status: 'alive' });
    },

    /** Full report. 503 only when fresh data is impossible, so monitors alert on real outages. */
    async check(_req: Request, res: Response): Promise<void> {
      const report = await service.check();
      res.setHeader('cache-control', 'no-store');
      res.status(report.status === 'down' ? 503 : 200).json(report);
    },
  };
}

export type HealthController = ReturnType<typeof createHealthController>;
