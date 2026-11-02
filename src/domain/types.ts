export const SUPPLIERS = ['supplierA', 'supplierB'] as const;
export type SupplierName = (typeof SUPPLIERS)[number];

/** One hotel as a supplier reports it. */
export interface SupplierHotel {
  hotelId: string;
  name: string;
  city: string;
  price: number;
  commissionPct: number;
}

export interface SupplierResult {
  supplier: SupplierName;
  hotels: SupplierHotel[];
}

/** The single offer we keep per hotel after comparing suppliers. */
export interface HotelOffer {
  name: string;
  city: string;
  price: number;
  commissionPct: number;
  supplier: SupplierName;
}
