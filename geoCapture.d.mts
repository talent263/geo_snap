export interface GeoLocationPayload {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  plusCode: string;
  resolvedAddress: string;
  locationSource: 'live_gps' | 'manual_pin';
  capturedAt: string;
}

export const ZIMBABWE_BOUNDS: Readonly<{
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
}>;

export function isWithinZimbabwe(latitude: number, longitude: number): boolean;
export function encodePlusCode(latitude: number, longitude: number): string;
export function createGeoLocationPayload(input: {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  resolvedAddress?: string;
  locationSource?: 'live_gps' | 'manual_pin';
  capturedAt?: string;
}): GeoLocationPayload;

export function persistOfflineReport(report: { id: string; [key: string]: unknown }): Promise<void>;
export function loadOfflineQueue(): Promise<{
  reports: Array<{ id: string; [key: string]: unknown }>;
  outbox: Array<{ id: string }>;
}>;
export function markOfflineReportSynced(report: { id: string; [key: string]: unknown }): Promise<void>;
export function clearOfflineReports(): Promise<void>;

export function coordinatesToWorldPixel(latitude: number, longitude: number, zoom: number): { x: number; y: number };
export function worldPixelToCoordinates(x: number, y: number, zoom: number): { latitude: number; longitude: number };
