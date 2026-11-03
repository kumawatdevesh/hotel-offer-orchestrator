import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi, { type JsonObject } from 'swagger-ui-express';
import { parse } from 'yaml';

// Same depth from src/routes (tsx) and dist/routes (built), so this works in both.
export const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.yaml');

/** Reads the hand-written OpenAPI spec. Throws at startup if the file is missing or broken. */
export function loadOpenApiSpec(file: string = OPENAPI_PATH): JsonObject {
  return parse(readFileSync(file, 'utf8')) as JsonObject;
}

// Swagger UI needs looser rules than the API: "Try it out" calls the mock suppliers on
// another localhost port, and pages served over plain http must not be upgraded to https.
const docsSecurityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      connectSrc: ["'self'", 'http://localhost:*'],
      upgradeInsecureRequests: null,
    },
  },
  hsts: false,
});

/**
 *   GET /docs               Swagger UI ("Try it out" against this API)
 *   GET /docs/openapi.json  the spec as JSON (import into Postman, codegen, ...)
 */
export function createDocsRouter(spec: JsonObject): Router {
  const router = Router();
  router.use(docsSecurityHeaders);
  router.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });
  router.use(swaggerUi.serve);
  router.get('/', swaggerUi.setup(spec, { customSiteTitle: 'Hotel Offer Orchestrator API' }));
  return router;
}
