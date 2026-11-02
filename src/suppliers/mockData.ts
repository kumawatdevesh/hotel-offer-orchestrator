import type { SupplierHotel, SupplierName } from '../domain/types';

// Overlapping inventory with small differences in price, commission, case and spacing,
// so every selection rule (cheaper, commission tie-break, name matching) shows up in real responses.
export const MOCK_INVENTORY: Record<SupplierName, Record<string, SupplierHotel[]>> = {
  supplierA: {
    delhi: [
      { hotelId: 'a-del-1', name: 'Holtin', city: 'delhi', price: 6000, commissionPct: 10 },
      { hotelId: 'a-del-2', name: 'Radison', city: 'delhi', price: 5900, commissionPct: 13 },
      { hotelId: 'a-del-3', name: 'Taj ', city: 'delhi', price: 8000, commissionPct: 10 },
      { hotelId: 'a-del-4', name: 'Lemon Tree', city: 'delhi', price: 3200, commissionPct: 8 },
    ],
    mumbai: [
      { hotelId: 'a-mum-1', name: 'Trident', city: 'mumbai', price: 9500, commissionPct: 12 },
      { hotelId: 'a-mum-2', name: 'ITC Maratha', city: 'mumbai', price: 8800, commissionPct: 15 },
      { hotelId: 'a-mum-3', name: 'Fariyas', city: 'mumbai', price: 5400, commissionPct: 9 },
    ],
    bangalore: [
      {
        hotelId: 'a-blr-1',
        name: 'The Oberoi',
        city: 'bangalore',
        price: 11000,
        commissionPct: 14,
      },
      { hotelId: 'a-blr-2', name: 'Ibis', city: 'bangalore', price: 3900, commissionPct: 7 },
    ],
  },
  supplierB: {
    delhi: [
      { hotelId: 'b-del-1', name: 'holtin', city: 'delhi', price: 5340, commissionPct: 20 },
      { hotelId: 'b-del-2', name: 'Radison', city: 'delhi', price: 5900, commissionPct: 15 },
      { hotelId: 'b-del-3', name: 'Leela', city: 'delhi', price: 7000, commissionPct: 12 },
      { hotelId: 'b-del-4', name: 'lemon  tree', city: 'delhi', price: 3350, commissionPct: 11 },
    ],
    mumbai: [
      { hotelId: 'b-mum-1', name: 'Trident', city: 'mumbai', price: 9100, commissionPct: 10 },
      { hotelId: 'b-mum-2', name: 'itc maratha', city: 'mumbai', price: 8800, commissionPct: 12 },
      { hotelId: 'b-mum-3', name: 'Sea Princess', city: 'mumbai', price: 6200, commissionPct: 13 },
    ],
    bangalore: [
      {
        hotelId: 'b-blr-1',
        name: 'The Oberoi',
        city: 'bangalore',
        price: 10500,
        commissionPct: 10,
      },
      {
        hotelId: 'b-blr-2',
        name: 'Taj MG Road',
        city: 'bangalore',
        price: 8700,
        commissionPct: 16,
      },
    ],
  },
};

/** Rows that must never reach the merge: served by the `bad-data` chaos mode. */
export const MALFORMED_ROWS: unknown[] = [
  { hotelId: 'bad-1', name: '', city: 'delhi', price: 5000, commissionPct: 10 },
  { hotelId: 'bad-2', city: 'delhi', price: 5000, commissionPct: 10 },
  { hotelId: 'bad-3', name: 'Leela', city: 'delhi', price: -5, commissionPct: 10 },
  { hotelId: 'bad-4', name: 'Taj', city: 'delhi', price: 'abc', commissionPct: 10 },
];
