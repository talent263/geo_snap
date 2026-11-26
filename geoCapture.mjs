export const ZIMBABWE_BOUNDS = Object.freeze({
  minLatitude: -22.5,
  maxLatitude: -15.5,
  minLongitude: 25,
  maxLongitude: 33.2
});

const PLUS_CODE_ALPHABET = '23456789CFGHJMPQRVWX';
const PAIR_RESOLUTIONS = [20, 1, 0.05, 0.0025, 0.000125];
let databasePromise;

function openGeoSnapDatabase() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available.'));
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('geosnap-zim-v1', 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('reports')) database.createObjectStore('reports', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('outbox')) database.createObjectStore('outbox', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open offline report storage.'));
      request.onblocked = () => reject(new Error('Offline report storage is blocked by another tab.'));
    });
  }
  return databasePromise;
}

function runDatabaseTransaction(stores, mode, callback) {
  return openGeoSnapDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(stores, mode);
    callback(transaction);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Offline report storage failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Offline report storage was aborted.'));
  }));
}

export function persistOfflineReport(report) {
  return runDatabaseTransaction(['reports', 'outbox'], 'readwrite', (transaction) => {
    transaction.objectStore('reports').put(report);
    transaction.objectStore('outbox').put({ id: report.id });
  });
}

export async function loadOfflineQueue() {
  const database = await openGeoSnapDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['reports', 'outbox'], 'readonly');
    const reportsRequest = transaction.objectStore('reports').getAll();
    const outboxRequest = transaction.objectStore('outbox').getAll();
    transaction.oncomplete = () => resolve({ reports: reportsRequest.result || [], outbox: outboxRequest.result || [] });
    transaction.onerror = () => reject(transaction.error || new Error('Could not read offline reports.'));
    transaction.onabort = () => reject(transaction.error || new Error('Could not read offline reports.'));
  });
}

export function markOfflineReportSynced(report) {
  return runDatabaseTransaction(['reports', 'outbox'], 'readwrite', (transaction) => {
    transaction.objectStore('reports').put({ ...report, syncState: 'synced' });
    transaction.objectStore('outbox').delete(report.id);
  });
}

export function clearOfflineReports() {
  return runDatabaseTransaction(['reports', 'outbox'], 'readwrite', (transaction) => {
    transaction.objectStore('reports').clear();
    transaction.objectStore('outbox').clear();
  });
}

export function isWithinZimbabwe(latitude, longitude) {
  return Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= ZIMBABWE_BOUNDS.minLatitude &&
    latitude <= ZIMBABWE_BOUNDS.maxLatitude &&
    longitude >= ZIMBABWE_BOUNDS.minLongitude &&
    longitude <= ZIMBABWE_BOUNDS.maxLongitude;
}

/** Returns a full, 10 digit Open Location Code (Plus Code). */
export function encodePlusCode(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new RangeError('Valid latitude and longitude are required to create a Plus Code.');
  }

  // OLC represents +90 as the last addressable point below the pole.
  const clippedLatitude = Math.max(-90, Math.min(90, latitude));
  const normalizedLatitude = clippedLatitude === 90 ? 89.999999999 : clippedLatitude;
  const normalizedLongitude = ((longitude + 180) % 360 + 360) % 360 - 180;
  let latitudeValue = normalizedLatitude + 90;
  let longitudeValue = normalizedLongitude + 180;
  let code = '';

  for (const resolution of PAIR_RESOLUTIONS) {
    const latitudeDigit = Math.floor(latitudeValue / resolution);
    const longitudeDigit = Math.floor(longitudeValue / resolution);
    code += PLUS_CODE_ALPHABET[Math.min(19, Math.max(0, latitudeDigit))];
    code += PLUS_CODE_ALPHABET[Math.min(19, Math.max(0, longitudeDigit))];
    latitudeValue -= latitudeDigit * resolution;
    longitudeValue -= longitudeDigit * resolution;
  }

  return `${code.slice(0, 8)}+${code.slice(8)}`;
}

export function createGeoLocationPayload({
  latitude,
  longitude,
  accuracyMeters = 0,
  resolvedAddress = '',
  locationSource = 'live_gps',
  capturedAt = new Date().toISOString()
}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new TypeError('A finite latitude and longitude are required.');
  }
  if (!isWithinZimbabwe(latitude, longitude)) {
    throw new RangeError('The report location must fall within Zimbabwe.');
  }
  if (!['live_gps', 'manual_pin'].includes(locationSource)) {
    throw new TypeError('locationSource must be live_gps or manual_pin.');
  }
  const capturedAtDate = new Date(capturedAt);
  if (Number.isNaN(capturedAtDate.getTime())) {
    throw new TypeError('capturedAt must be a valid ISO-8601 timestamp.');
  }

  return {
    latitude,
    longitude,
    accuracyMeters: Number.isFinite(accuracyMeters) ? accuracyMeters : 0,
    plusCode: encodePlusCode(latitude, longitude),
    resolvedAddress: String(resolvedAddress || '').trim(),
    locationSource,
    capturedAt: capturedAtDate.toISOString()
  };
}

export function coordinatesToWorldPixel(latitude, longitude, zoom) {
  const scale = 256 * 2 ** zoom;
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const sin = Math.sin((clampedLatitude * Math.PI) / 180);
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
  };
}

export function worldPixelToCoordinates(x, y, zoom) {
  const scale = 256 * 2 ** zoom;
  const longitude = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const latitude = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { latitude, longitude };
}
