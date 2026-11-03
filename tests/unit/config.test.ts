import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env';

describe('loadConfig', () => {
  it('fills defaults when env is empty', () => {
    const config = loadConfig({});
    expect(config.PORT).toBe(3000);
    expect(config.SUPPLIER_TIMEOUT_MS).toBe(2000);
    expect(config.TEMPORAL_TASK_QUEUE).toBe('hotel-offers');
  });

  it('turns numeric strings into numbers', () => {
    expect(loadConfig({ PORT: '8080' }).PORT).toBe(8080);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('reads SERVE_MOCK_SUPPLIERS=%s as %s', (value, expected) => {
    expect(loadConfig({ SERVE_MOCK_SUPPLIERS: value }).SERVE_MOCK_SUPPLIERS).toBe(expected);
  });

  it('lists every bad variable in one error', () => {
    expect(() => loadConfig({ PORT: 'abc', REDIS_URL: 'not-a-url' })).toThrow(
      /PORT[\s\S]*REDIS_URL|REDIS_URL[\s\S]*PORT/,
    );
  });

  it('rejects a hard TTL shorter than the fresh TTL', () => {
    expect(() =>
      loadConfig({ CACHE_FRESH_TTL_SECONDS: '600', CACHE_HARD_TTL_SECONDS: '60' }),
    ).toThrow(/CACHE_HARD_TTL_SECONDS/);
  });
});
