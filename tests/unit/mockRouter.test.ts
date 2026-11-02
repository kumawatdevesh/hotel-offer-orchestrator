import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createMockSupplierRouter } from '../../src/suppliers/mockRouter';

function app(allowChaos = true) {
  return express().use(createMockSupplierRouter({ allowChaos, slowMs: 50 }));
}

describe('mock supplier router', () => {
  it('returns the inventory for a city, ignoring case', async () => {
    const res = await request(app()).get('/supplierA/hotels?city=Delhi');
    expect(res.status).toBe(200);
    expect(res.body.map((h: { name: string }) => h.name)).toContain('Holtin');
  });

  it('returns an empty list for an unknown city', async () => {
    const res = await request(app()).get('/supplierB/hotels?city=paris');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('rejects a missing city', async () => {
    const res = await request(app()).get('/supplierA/hotels');
    expect(res.status).toBe(400);
  });

  it('fail mode returns 500 for that supplier only', async () => {
    const server = app();
    await request(server).post('/supplierB/_chaos').send({ mode: 'fail' }).expect(200);

    expect((await request(server).get('/supplierB/hotels?city=delhi')).status).toBe(500);
    expect((await request(server).get('/supplierA/hotels?city=delhi')).status).toBe(200);
  });

  it('bad-data mode mixes malformed rows into good ones', async () => {
    const server = app();
    await request(server).post('/supplierA/_chaos').send({ mode: 'bad-data' });
    const res = await request(server).get('/supplierA/hotels?city=delhi');
    expect(res.body.some((h: { hotelId: string }) => h.hotelId === 'bad-1')).toBe(true);
    expect(res.body.some((h: { name: string }) => h.name === 'Holtin')).toBe(true);
  });

  it('switching back to ok restores normal responses', async () => {
    const server = app();
    await request(server).post('/supplierB/_chaos').send({ mode: 'fail' });
    await request(server).post('/supplierB/_chaos').send({ mode: 'ok' });
    expect((await request(server).get('/supplierB/hotels?city=delhi')).status).toBe(200);
  });

  it('rejects an unknown chaos mode', async () => {
    const res = await request(app()).post('/supplierA/_chaos').send({ mode: 'explode' });
    expect(res.status).toBe(400);
  });

  it('hides the chaos endpoint when not allowed', async () => {
    const res = await request(app(false)).post('/supplierA/_chaos').send({ mode: 'fail' });
    expect(res.status).toBe(404);
  });
});
