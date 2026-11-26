# GeoSnap Zim

GeoSnap Zim is a React civic reporting app for waste reports and community suggestions in Zimbabwe. It uses Vite, Tailwind CSS, and Lucide icons.

## Requirements

- Node.js 20.19+ or 22.12+ (Vite 8 requirement)
- npm
- A modern browser

## Run locally

```bash
npm install
npm run dev
```

Vite serves the app at `http://localhost:5173/` by default. Use `Ctrl+C` to stop the server.

## Commands

```bash
npm run dev      # Start the Vite development server
npm run build    # Build static files into dist/
npm run preview  # Preview the production build locally
npm test         # Run the Node.js helper tests
```

## Camera and location

Open **Snap / Idea** to create a report or suggestion. The form requests high-accuracy location while it is open. Camera and location access require user permission; browsers generally require HTTPS, with localhost treated as a secure development origin.

The in-app camera prefers the rear camera, offers a front/rear switch when multiple cameras are detected, and has a native camera/file fallback. Photos are resized to a maximum 1600 px on the longest edge, re-encoded as WebP or JPEG, and reduced toward 500 KB. Re-encoding removes EXIF metadata. GPS is stored in the report payload instead.

If GPS is unavailable, stale, or outside the configured Zimbabwe bounding box, place a pin on the map and choose the suburb or landmark. Map coordinates selected manually use `locationSource: "manual_pin"` and `accuracyMeters: 0` (no GPS accuracy measurement); live fixes use `locationSource: "live_gps"` and include the measured accuracy.

Each newly created report includes a `geoLocation` object:

```ts
interface GeoLocationPayload {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  plusCode: string;
  resolvedAddress: string;
  locationSource: 'live_gps' | 'manual_pin';
  capturedAt: string; // ISO-8601 UTC
}
```

For photo reports, `capturedAt` is recorded at capture/selection time. For reports without a photo, it is recorded at submission. A separate `gpsSnapshot` retains the browser fix fields, including altitude, heading, and the browser timestamp, when available. Plus Codes are full 10-digit Open Location Codes.

## Runtime services

The repository has no backend or database implementation. By default, posts are saved locally and placed in an IndexedDB outbox (with a localStorage fallback). The app retries queued posts while open when it is online and a server URL is configured. Configure `window.__GEOSNAP_CONFIG__` before `/main.tsx` loads to connect services:

```html
<script>
  window.__GEOSNAP_CONFIG__ = {
    apiBaseUrl: '/api',
    geocodingUrl: '/api/geocoding/reverse',
    mapTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    mapAttribution: '© OpenStreetMap contributors'
  };
</script>
```

The configured API must accept `POST {apiBaseUrl}/posts` with the created post JSON. The request includes an `Idempotency-Key` header containing the post ID. A successful 2xx response removes that report from the outbox. The payload contains the `geoLocation` contract, `gpsSnapshot`, post fields, and `customImage` as a compressed data URL when a photo is attached. The API should validate the geofence and payload again on the server.

`geocodingUrl` must accept `lat`, `lon`, `format=jsonv2`, `zoom`, and `addressdetails` query parameters and return a Nominatim-compatible JSON response. If it is omitted, the app uses the public Nominatim reverse endpoint as a low-volume fallback. For production traffic, configure a geocoding provider or proxy that meets your usage, identification, privacy, and availability needs. The public Nominatim service limits usage to one request per second; see its [usage policy](https://operations.osmfoundation.org/policies/nominatim/).

`mapTileUrl` is a `{z}/{x}/{y}` tile URL template. The default map uses OpenStreetMap standard tiles and displays attribution. For production usage, choose a provider suitable for your traffic and follow its caching, attribution, and offline-use terms. See the [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/).

The example config above is illustrative. Adjust the API, geocoder, and tile provider URLs for the deployment environment; ensure any cross-origin endpoints allow the app origin.

## Tests

The built-in Node test suite covers Zimbabwe bounds, Plus Code generation, payload validation/timestamps, and map coordinate projection. It does not exercise camera hardware, browser geolocation permissions, or external mapping services.
