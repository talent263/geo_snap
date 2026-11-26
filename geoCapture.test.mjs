import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGeoLocationPayload,
  encodePlusCode,
  isWithinZimbabwe,
  worldPixelToCoordinates,
  coordinatesToWorldPixel
} from './geoCapture.mjs';

test('Zimbabwe bounds include its configured edges and reject outside points', () => {
  assert.equal(isWithinZimbabwe(-17.8252, 31.0335), true);
  assert.equal(isWithinZimbabwe(-22.5, 25), true);
  assert.equal(isWithinZimbabwe(-22.5001, 31), false);
  assert.equal(isWithinZimbabwe(-17, 33.2001), false);
  assert.equal(isWithinZimbabwe(Number.NaN, 31), false);
});

test('Plus Code output is a full ten digit Open Location Code', () => {
  assert.match(encodePlusCode(-17.8252, 31.0335), /^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2}$/);
  assert.equal(encodePlusCode(47.36559, 8.524997), '8FVC9G8F+6X');
  assert.equal(encodePlusCode(90, 0).length, 11);
  assert.equal(encodePlusCode(91, 0), encodePlusCode(90, 0));
  assert.throws(() => encodePlusCode(Number.NaN, 0), RangeError);
});

test('location payload preserves dispatch fields and normalizes capturedAt to UTC ISO', () => {
  const location = createGeoLocationPayload({
    latitude: -17.8252,
    longitude: 31.0335,
    accuracyMeters: 8.4,
    resolvedAddress: 'Mbare, Harare',
    locationSource: 'live_gps',
    capturedAt: '2026-11-26T10:30:00+02:00'
  });

  assert.deepEqual(Object.keys(location), [
    'latitude', 'longitude', 'accuracyMeters', 'plusCode', 'resolvedAddress', 'locationSource', 'capturedAt'
  ]);
  assert.equal(location.capturedAt, '2026-11-26T08:30:00.000Z');
  assert.equal(location.resolvedAddress, 'Mbare, Harare');
  assert.equal(location.locationSource, 'live_gps');
  assert.throws(() => createGeoLocationPayload({ latitude: -17, longitude: 31, locationSource: 'gps' }), TypeError);

  const manual = createGeoLocationPayload({
    latitude: -17.83,
    longitude: 31.04,
    locationSource: 'manual_pin',
    accuracyMeters: 0
  });
  assert.equal(manual.locationSource, 'manual_pin');
  assert.equal(manual.accuracyMeters, 0);
  assert.match(manual.capturedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.throws(() => createGeoLocationPayload({ latitude: 0, longitude: 0 }), RangeError);
});

test('map projection round trips a Zimbabwe point', () => {
  const original = { latitude: -20.1325, longitude: 28.6265 };
  const pixel = coordinatesToWorldPixel(original.latitude, original.longitude, 14);
  const decoded = worldPixelToCoordinates(pixel.x, pixel.y, 14);
  assert.ok(Math.abs(decoded.latitude - original.latitude) < 1e-9);
  assert.ok(Math.abs(decoded.longitude - original.longitude) < 1e-9);
});
