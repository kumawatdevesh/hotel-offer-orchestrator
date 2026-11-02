import { describe, expect, it } from 'vitest';
import { hotelKey, selectBestOffers } from '../../src/domain/selectBestOffers';
import type { SupplierHotel } from '../../src/domain/types';

function hotel(name: string, price: number, commissionPct: number): SupplierHotel {
  return { hotelId: name, name, city: 'delhi', price, commissionPct };
}

describe('hotelKey', () => {
  it('ignores case, outer spaces and repeated inner spaces', () => {
    expect(hotelKey('  The   Taj ')).toBe('the taj');
  });
});

describe('selectBestOffers', () => {
  it('keeps the cheaper offer', () => {
    const result = selectBestOffers([
      { supplier: 'supplierA', hotels: [hotel('Holtin', 6000, 10)] },
      { supplier: 'supplierB', hotels: [hotel('Holtin', 5340, 20)] },
    ]);
    expect(result).toEqual([
      { name: 'Holtin', city: 'delhi', price: 5340, commissionPct: 20, supplier: 'supplierB' },
    ]);
  });

  it('breaks a price tie by higher commission', () => {
    const result = selectBestOffers([
      { supplier: 'supplierA', hotels: [hotel('Radison', 5900, 15)] },
      { supplier: 'supplierB', hotels: [hotel('Radison', 5900, 13)] },
    ]);
    expect(result[0]).toMatchObject({ supplier: 'supplierA', commissionPct: 15 });
  });

  it('gives the same answer for a full tie regardless of input order', () => {
    const a = { supplier: 'supplierA' as const, hotels: [hotel('Leela', 7000, 12)] };
    const b = { supplier: 'supplierB' as const, hotels: [hotel('Leela', 7000, 12)] };
    expect(selectBestOffers([a, b])).toEqual(selectBestOffers([b, a]));
    expect(selectBestOffers([b, a])[0]?.supplier).toBe('supplierA');
  });

  it('treats prices equal to the paisa as a tie', () => {
    const result = selectBestOffers([
      { supplier: 'supplierA', hotels: [hotel('Oberoi', 9000.004, 10)] },
      { supplier: 'supplierB', hotels: [hotel('Oberoi', 9000, 18)] },
    ]);
    expect(result[0]).toMatchObject({ supplier: 'supplierB', price: 9000 });
  });

  it('merges names that differ only in case and spacing', () => {
    const result = selectBestOffers([
      { supplier: 'supplierA', hotels: [hotel('Taj ', 8000, 10)] },
      { supplier: 'supplierB', hotels: [hotel('taj', 8100, 10)] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'Taj', price: 8000 });
  });

  it('keeps hotels only one supplier has, sorted by price', () => {
    const result = selectBestOffers([
      {
        supplier: 'supplierA',
        hotels: [hotel('Holtin', 6000, 10), hotel('Radison', 5900, 13), hotel('Taj', 8000, 10)],
      },
      {
        supplier: 'supplierB',
        hotels: [hotel('Holtin', 5340, 20), hotel('Radison', 5900, 15), hotel('Leela', 7000, 12)],
      },
    ]);
    expect(result.map((o) => [o.name, o.price, o.supplier])).toEqual([
      ['Holtin', 5340, 'supplierB'],
      ['Radison', 5900, 'supplierB'],
      ['Leela', 7000, 'supplierB'],
      ['Taj', 8000, 'supplierA'],
    ]);
  });

  it('works when one supplier returned nothing', () => {
    const result = selectBestOffers([
      { supplier: 'supplierA', hotels: [hotel('Holtin', 6000, 10)] },
      { supplier: 'supplierB', hotels: [] },
    ]);
    expect(result).toEqual([
      { name: 'Holtin', city: 'delhi', price: 6000, commissionPct: 10, supplier: 'supplierA' },
    ]);
  });

  it('keeps the cheaper copy when one supplier lists a hotel twice', () => {
    const result = selectBestOffers([
      { supplier: 'supplierA', hotels: [hotel('Holtin', 6000, 10), hotel('holtin', 5800, 8)] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.price).toBe(5800);
  });

  it('returns an empty list for no input', () => {
    expect(selectBestOffers([])).toEqual([]);
  });
});
