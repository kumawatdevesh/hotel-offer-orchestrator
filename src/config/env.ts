import 'dotenv/config';
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();
// Env vars are strings, and z.coerce.boolean() would turn "false" into true.
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    REDIS_URL: z.string().url().default('redis://localhost:6379'),

    TEMPORAL_ADDRESS: z.string().min(1).default('localhost:7233'),
    TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
    TEMPORAL_TASK_QUEUE: z.string().min(1).default('hotel-offers'),
    // Upper bound on how long the API waits for a workflow before falling back to cache.
    WORKFLOW_TIMEOUT_MS: positiveInt.default(5_000),

    SUPPLIER_A_URL: z.string().url().default('http://localhost:3000/supplierA'),
    SUPPLIER_B_URL: z.string().url().default('http://localhost:3000/supplierB'),
    SUPPLIER_TIMEOUT_MS: positiveInt.default(2_000),
    // Mount the mock supplier routes on the API. docker-compose turns this off and runs them
    // as their own container, so the API only reaches suppliers over the network.
    SERVE_MOCK_SUPPLIERS: flag.default('true'),

    // Data younger than this is served as fresh; older data is only a fallback.
    CACHE_FRESH_TTL_SECONDS: positiveInt.default(600),
    // Redis drops the keys after this, so stale fallback data has a hard limit.
    CACHE_HARD_TTL_SECONDS: positiveInt.default(86_400),

    // Consecutive failures that open a supplier's circuit (stop calling it for a while).
    CIRCUIT_FAILURE_THRESHOLD: positiveInt.default(5),
    // How long an open circuit skips the supplier before letting a trial call through.
    CIRCUIT_OPEN_SECONDS: positiveInt.default(30),
    // The failure count resets after this long with no new failure.
    CIRCUIT_RESET_WINDOW_SECONDS: positiveInt.default(60),

    // Upper bound for each /health probe (Redis, Temporal, each supplier).
    HEALTH_PROBE_TIMEOUT_MS: positiveInt.default(1_000),
    // /health reuses its last report for this long, so monitors can't flood the suppliers.
    HEALTH_CACHE_MS: positiveInt.default(5_000),
  })
  .refine((c) => c.CACHE_HARD_TTL_SECONDS >= c.CACHE_FRESH_TTL_SECONDS, {
    message: 'CACHE_HARD_TTL_SECONDS must be >= CACHE_FRESH_TTL_SECONDS',
    path: ['CACHE_HARD_TTL_SECONDS'],
  })
  // The count must outlive the open period, so one failed trial call re-opens the circuit at once.
  .refine((c) => c.CIRCUIT_RESET_WINDOW_SECONDS > c.CIRCUIT_OPEN_SECONDS, {
    message: 'CIRCUIT_RESET_WINDOW_SECONDS must be > CIRCUIT_OPEN_SECONDS',
    path: ['CIRCUIT_RESET_WINDOW_SECONDS'],
  });

export type Config = z.infer<typeof schema>;

/** Parses env into typed config; throws one readable error listing every bad variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

export const config = loadConfig();
