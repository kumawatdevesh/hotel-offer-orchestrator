import SwaggerParser from '@apidevtools/swagger-parser';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { OPENAPI_PATH, createDocsRouter, loadOpenApiSpec } from '../../src/routes/docs.routes';

const spec = loadOpenApiSpec();

/** Same order as app.ts: docs first with their own headers, strict helmet for everything else. */
function app() {
  return express()
    .use('/docs', createDocsRouter(spec))
    .use(helmet())
    .get('/api/ping', (_req, res) => {
      res.json({ ok: true });
    });
}

describe('OpenAPI spec', () => {
  it('is a valid OpenAPI document', async () => {
    await expect(SwaggerParser.validate(OPENAPI_PATH)).resolves.toBeDefined();
  });

  it('documents every route the services expose', () => {
    expect(Object.keys(spec.paths).sort()).toEqual(
      ['/api/hotels', '/health', '/health/live', '/{supplier}/hotels', '/{supplier}/_chaos'].sort(),
    );
  });
});

describe('docs routes', () => {
  it('GET /docs/ serves Swagger UI', async () => {
    const res = await request(app()).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
    expect(res.text).toContain('Hotel Offer Orchestrator API');
  });

  it('GET /docs/openapi.json returns the spec', async () => {
    const res = await request(app()).get('/docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.info.title).toBe('Hotel Offer Orchestrator');
  });

  it('loosens security headers only for the docs', async () => {
    const docs = await request(app()).get('/docs/');
    expect(docs.headers['content-security-policy']).toContain('http://localhost:*');
    expect(docs.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');

    const api = await request(app()).get('/api/ping');
    expect(api.headers['content-security-policy']).toContain('upgrade-insecure-requests');
    expect(api.headers['content-security-policy']).not.toContain('localhost');
  });
});
