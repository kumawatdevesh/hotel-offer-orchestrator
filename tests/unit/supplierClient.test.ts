import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockSupplierRouter } from '../../src/suppliers/mockRouter';
import { fetchSupplierHotels, SupplierError } from '../../src/suppliers/supplierClient';

// A real HTTP server, so timeouts and status codes go through actual fetch.
const app = express()
  .use(createMockSupplierRouter({ allowChaos: true, slowMs: 300 }))
  .get('/notalist/hotels', (_req, res) => {
    res.json({ oops: 1 });
  })
  .get('/notjson/hotels', (_req, res) => {
    res.type('text').send('<html>gateway error</html>');
  });

let server: Server;
let base: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  await request(app).post('/supplierA/_chaos').send({ mode: 'ok' });
  await request(app).post('/supplierB/_chaos').send({ mode: 'ok' });
});

async function failureOf(promise: Promise<unknown>): Promise<SupplierError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SupplierError);
  return err as SupplierError;
}

describe('fetchSupplierHotels', () => {
  it('returns validated hotels', async () => {
    const hotels = await fetchSupplierHotels('supplierA', 'delhi', {
      baseUrl: `${base}/supplierA`,
    });
    expect(hotels.length).toBeGreaterThan(0);
    expect(hotels[0]).toHaveProperty('price');
  });

  it('drops malformed rows and keeps the good ones', async () => {
    await request(app).post('/supplierB/_chaos').send({ mode: 'bad-data' });
    const hotels = await fetchSupplierHotels('supplierB', 'delhi', {
      baseUrl: `${base}/supplierB`,
    });
    expect(hotels.map((h) => h.hotelId)).toEqual(['b-del-1', 'b-del-2', 'b-del-3', 'b-del-4']);
  });

  it('times out a slow supplier', async () => {
    await request(app).post('/supplierB/_chaos').send({ mode: 'slow' });
    const err = await failureOf(
      fetchSupplierHotels('supplierB', 'delhi', { baseUrl: `${base}/supplierB`, timeoutMs: 100 }),
    );
    expect(err).toMatchObject({ supplier: 'supplierB', reason: 'timeout', retryable: false });
  });

  it('reports a 500 as a retryable http failure', async () => {
    await request(app).post('/supplierA/_chaos').send({ mode: 'fail' });
    const err = await failureOf(
      fetchSupplierHotels('supplierA', 'delhi', { baseUrl: `${base}/supplierA` }),
    );
    expect(err).toMatchObject({ reason: 'http', retryable: true });
  });

  it('reports a body that is not a list as non-retryable', async () => {
    const err = await failureOf(
      fetchSupplierHotels('supplierA', 'delhi', { baseUrl: `${base}/notalist` }),
    );
    expect(err).toMatchObject({ reason: 'invalid_response', retryable: false });
  });

  it('reports non-JSON as non-retryable', async () => {
    const err = await failureOf(
      fetchSupplierHotels('supplierA', 'delhi', { baseUrl: `${base}/notjson` }),
    );
    expect(err).toMatchObject({ reason: 'invalid_response', retryable: false });
  });

  it('reports an unreachable supplier as a network failure', async () => {
    const err = await failureOf(
      fetchSupplierHotels('supplierA', 'delhi', { baseUrl: 'http://127.0.0.1:1' }),
    );
    expect(err).toMatchObject({ reason: 'network', retryable: true });
  });
});
