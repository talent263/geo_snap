import React, { useState, useEffect, useRef } from 'react';
import {
  Heart,
  MessageCircle,
  Share2,
  Bookmark,
  MapPin,
  PlusSquare,
  Home,
  BarChart2,
  User,
  ShieldAlert,
  CheckCircle2,
  Truck,
  Lightbulb,
  Trash2,
  Camera,
  Upload,
  X,
  Send,
  Sparkles,
  Award,
  Filter,
  SlidersHorizontal,
  ChevronRight,
  Clock,
  Leaf,
  AlertTriangle,
  Check,
  Navigation,
  RefreshCw,
  Eye
} from 'lucide-react';
import {
  clearOfflineReports,
  createGeoLocationPayload,
  coordinatesToWorldPixel,
  encodePlusCode,
  isWithinZimbabwe,
  loadOfflineQueue,
  markOfflineReportSynced,
  persistOfflineReport,
  worldPixelToCoordinates
} from './geoCapture.mjs';

export interface GeoLocationPayload {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  plusCode: string;
  resolvedAddress: string;
  locationSource: 'live_gps' | 'manual_pin';
  capturedAt: string;
}

// Runtime config: apiBaseUrl expects POST {apiBaseUrl}/posts with a GeoSnap post body;
// geocodingUrl should provide a Nominatim-compatible reverse endpoint; mapTileUrl uses {z}/{x}/{y}.
declare global {
  interface Window {
    __GEOSNAP_CONFIG__?: {
      apiBaseUrl?: string;
      geocodingUrl?: string;
      geocodingEmail?: string;
      mapTileUrl?: string;
      mapAttribution?: string;
    };
  }
}

const HARARE_COORDINATES = { latitude: -17.8252, longitude: 31.0335 };
const MAX_IMAGE_BYTES = 500 * 1024;

const readBlobAsDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error('Could not read the selected image.'));
  reader.readAsDataURL(blob);
});

const canvasToBlob = (canvas, type, quality) => new Promise((resolve) => {
  canvas.toBlob(resolve, type, quality);
});

async function loadImageElement(source) {
  const objectUrl = URL.createObjectURL(source);
  try {
    return await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('This image could not be opened.'));
      element.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function compressImageSource(source) {
  let image;
  let ownedImage = false;
  if (typeof createImageBitmap === 'function') {
    try {
      image = await createImageBitmap(source);
      ownedImage = true;
    } catch {
      image = source instanceof HTMLVideoElement ? source : await loadImageElement(source);
    }
  } else if (source instanceof HTMLVideoElement) {
    image = source;
  } else {
    image = await loadImageElement(source);
  }

  try {
    const sourceWidth = image.width || image.videoWidth;
    const sourceHeight = image.height || image.videoHeight;
    if (!sourceWidth || !sourceHeight) throw new Error('The camera did not return a usable image.');
    const initialScale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight));
    const formats = ['image/webp', 'image/jpeg'];
    const sizeFactors = [1, 0.85, 0.7, 0.55, 0.4];
    const qualities = [0.82, 0.72, 0.62, 0.52];

    for (const sizeFactor of sizeFactors) {
      const scale = initialScale * sizeFactor;
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Image compression is unavailable in this browser.');
      context.drawImage(image, 0, 0, width, height);

      for (const quality of qualities) {
        for (const format of formats) {
          const blob = await canvasToBlob(canvas, format, quality);
          // Re-encoding through canvas removes source EXIF blocks. Location remains in GeoSnap metadata.
          if (blob && blob.size < MAX_IMAGE_BYTES && ['image/webp', 'image/jpeg'].includes(blob.type)) {
            return blob;
          }
          // Unsupported WebP encoders return a PNG blob. Try JPEG at the same dimensions.
          if (blob?.type === 'image/png' && format === 'image/webp') continue;
        }
      }
    }
    throw new Error('This image could not be reduced below 500 KB. Try a smaller photo.');
  } finally {
    if (ownedImage && image.close) image.close();
  }
}

function useLiveGeolocation(enabled) {
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);
  const latestPositionRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      latestPositionRef.current = null;
      setPosition(null);
      setError(null);
      return undefined;
    }
    if (!navigator.geolocation?.watchPosition) {
      setError({ code: 'unsupported', message: 'Location is not supported on this device.' });
      return undefined;
    }

    setError(null);
    const watchId = navigator.geolocation.watchPosition(
      (result) => {
        const fix = {
          latitude: result.coords.latitude,
          longitude: result.coords.longitude,
          accuracy: result.coords.accuracy,
          altitude: result.coords.altitude,
          heading: result.coords.heading,
          timestamp: result.timestamp
        };
        latestPositionRef.current = fix;
        setPosition(fix);
        setError(null);
      },
      (geoError) => setError({ code: geoError.code, message: geoError.message }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      latestPositionRef.current = null;
    };
  }, [enabled]);

  return {
    position,
    error,
    snapshot: () => latestPositionRef.current
  };
}

function reverseGeocodeUrl(latitude, longitude) {
  const config = window.__GEOSNAP_CONFIG__ || {};
  const endpoint = config.geocodingUrl || 'https://nominatim.openstreetmap.org/reverse';
  const url = new URL(endpoint, window.location.href);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(latitude));
  url.searchParams.set('lon', String(longitude));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'en');
  if (config.geocodingEmail) url.searchParams.set('email', config.geocodingEmail);
  return url.toString();
}

function formatResolvedAddress(data) {
  const address = data?.address || {};
  const street = address.road || address.pedestrian || address.path || address.footway;
  const suburb = address.suburb || address.neighbourhood || address.city_district || address.quarter;
  const town = address.city || address.town || address.village || address.municipality || address.county;
  const parts = [street, suburb, town, address.state].filter(Boolean);
  return [...new Set(parts)].join(', ') || data?.display_name || '';
}

function useReverseGeocode(point, enabled) {
  const [result, setResult] = useState({ address: '', loading: false, error: false, coordsKey: '' });
  const coordsKey = point ? `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}` : '';

  useEffect(() => {
    if (!enabled || !point || !isWithinZimbabwe(point.latitude, point.longitude)) {
      setResult({ address: '', loading: false, error: false, coordsKey });
      return undefined;
    }

    let isCurrent = true;
    const cacheKey = `geosnap_reverse_v1_${coordsKey}`;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        setResult({ address: cached, loading: false, error: false, coordsKey });
        return undefined;
      }
    } catch {
      // Reverse geocoding still works when browser storage is unavailable.
    }

    setResult({ address: '', loading: true, error: false, coordsKey });
    const controller = new AbortController();
    let timedOut = false;
    let requestTimeout;
    const timer = setTimeout(async () => {
      try {
        requestTimeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, 10000);
        const response = await fetch(reverseGeocodeUrl(point.latitude, point.longitude), {
          signal: controller.signal,
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`Geocoding failed (${response.status}).`);
        const address = formatResolvedAddress(await response.json());
        if (!address) throw new Error('No address was found for this location.');
        if (isCurrent) {
          setResult({ address, loading: false, error: false, coordsKey });
          try { localStorage.setItem(cacheKey, address); } catch { /* Cache is optional. */ }
        }
      } catch (geocodeError) {
        if (isCurrent && (geocodeError.name !== 'AbortError' || timedOut)) {
          setResult({ address: '', loading: false, error: true, coordsKey });
        }
      } finally {
        clearTimeout(requestTimeout);
      }
    }, 1100);

    return () => {
      isCurrent = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, coordsKey]);

  return result;
}

function CameraCapture({ onCapture, getCaptureContext, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const isMountedRef = useRef(false);
  const cameraRequestRef = useRef(0);
  const inputRef = useRef(null);
  const previewUrlRef = useRef(null);
  const [cameraError, setCameraError] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [facingMode, setFacingMode] = useState('environment');
  const [videoInputCount, setVideoInputCount] = useState(0);
  const [capturedImage, setCapturedImage] = useState(null);
  const [processing, setProcessing] = useState(false);

  const stopCamera = () => {
    cameraRequestRef.current += 1;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (isMountedRef.current) setCameraReady(false);
  };

  const startCamera = async (mode = facingMode) => {
    stopCamera();
    const requestId = ++cameraRequestRef.current;
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('In-app camera is unavailable on this browser. Use the camera or upload button below.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: mode },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      if (!isMountedRef.current || requestId !== cameraRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      if (!isMountedRef.current || requestId !== cameraRequestRef.current) return;
      setCameraReady(true);
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (isMountedRef.current && requestId === cameraRequestRef.current) {
          setVideoInputCount(devices.filter((device) => device.kind === 'videoinput').length);
        }
      } catch {
        if (isMountedRef.current && requestId === cameraRequestRef.current) setVideoInputCount(0);
      }
    } catch (cameraOpenError) {
      if (isMountedRef.current && requestId === cameraRequestRef.current) {
        setCameraError(
          cameraOpenError.name === 'NotAllowedError'
            ? 'Camera permission was blocked. Use the native camera or choose a photo instead.'
            : 'Could not open the camera. Use the native camera or choose a photo instead.'
        );
      }
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    startCamera('environment');
    return () => {
      isMountedRef.current = false;
      cameraRequestRef.current += 1;
      if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const selectImage = async (source, context) => {
    setProcessing(true);
    try {
      const compressed = await compressImageSource(source);
      if (!isMountedRef.current) return;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = URL.createObjectURL(compressed);
      setCapturedImage({ blob: compressed, context });
      stopCamera();
    } catch (imageError) {
      if (isMountedRef.current) setCameraError(imageError.message || 'Could not process this photo. Try another image.');
    } finally {
      if (isMountedRef.current) setProcessing(false);
    }
  };

  const takePhoto = async () => {
    if (!videoRef.current?.videoWidth || processing) return;
    const context = getCaptureContext();
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    stopCamera();
    await selectImage(canvas, context);
  };

  const handleFallbackFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const context = getCaptureContext();
    stopCamera();
    await selectImage(file, context);
  };

  const handleRetake = () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setCapturedImage(null);
    startCamera(facingMode);
  };

  const handleConfirm = async () => {
    if (!capturedImage || processing) return;
    await onCapture(capturedImage.blob, capturedImage.context);
    onClose();
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-950 p-3 space-y-3">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
        {capturedImage ? (
          <img src={previewUrlRef.current} alt="Captured photo preview" className="h-full w-full object-contain" />
        ) : (
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
        )}
        {processing && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm font-semibold text-white">
            Optimizing photo…
          </div>
        )}
      </div>
      {cameraError && <p role="status" className="text-xs leading-relaxed text-amber-200">{cameraError}</p>}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {capturedImage ? (
          <>
            <button type="button" onClick={handleRetake} className="rounded-full bg-slate-700 px-4 py-2 text-xs font-bold text-white">
              Retake
            </button>
            <button type="button" onClick={handleConfirm} disabled={processing} className="rounded-full bg-emerald-500 px-4 py-2 text-xs font-extrabold text-slate-950 disabled:opacity-50">
              Use Photo
            </button>
          </>
        ) : (
          <>
            {cameraReady && (
              <button type="button" onClick={takePhoto} disabled={processing} aria-label="Take photo" className="h-12 w-12 rounded-full border-4 border-white bg-rose-500 shadow-lg disabled:opacity-50" />
            )}
            {videoInputCount > 1 && cameraReady && (
              <button
                type="button"
                onClick={() => {
                  const nextMode = facingMode === 'environment' ? 'user' : 'environment';
                  setFacingMode(nextMode);
                  startCamera(nextMode);
                }}
                className="rounded-full bg-slate-700 px-3 py-2 text-xs font-bold text-white"
              >
                Switch camera
              </button>
            )}
            <label className="cursor-pointer rounded-full bg-slate-700 px-3 py-2 text-xs font-bold text-white">
              Use device camera / upload
              <input ref={inputRef} type="file" accept="image/*" capture="environment" onChange={handleFallbackFile} className="sr-only" />
            </label>
          </>
        )}
        <button type="button" onClick={onClose} className="rounded-full bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200">Close</button>
      </div>
      <p className="text-center text-[10px] text-slate-400">Photos are resized to 1600 px max and compressed below 500 KB. EXIF is removed; report GPS is saved separately.</p>
    </div>
  );
}

function ManualPinPicker({ initialCenter, selectedPoint, onSelect }) {
  const mapElementRef = useRef(null);
  const [width, setWidth] = useState(360);
  const height = 220;
  const [zoom, setZoom] = useState(14);
  const [mapCenter, setMapCenter] = useState(initialCenter || HARARE_COORDINATES);
  const [latitudeText, setLatitudeText] = useState(selectedPoint?.latitude?.toFixed(6) || '');
  const [longitudeText, setLongitudeText] = useState(selectedPoint?.longitude?.toFixed(6) || '');
  const dragRef = useRef(null);
  const centerPixel = coordinatesToWorldPixel(mapCenter.latitude, mapCenter.longitude, zoom);
  const firstTileX = Math.floor((centerPixel.x - width / 2) / 256);
  const firstTileY = Math.floor((centerPixel.y - height / 2) / 256);
  const cols = Math.ceil(width / 256) + 1;
  const rows = Math.ceil(height / 256) + 1;
  const config = window.__GEOSNAP_CONFIG__ || {};
  const tileTemplate = config.mapTileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const marker = selectedPoint && coordinatesToWorldPixel(selectedPoint.latitude, selectedPoint.longitude, zoom);

  useEffect(() => {
    const element = mapElementRef.current;
    if (!element) return undefined;
    const measure = () => setWidth(element.clientWidth || 360);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setLatitudeText(selectedPoint?.latitude?.toFixed(6) || '');
    setLongitudeText(selectedPoint?.longitude?.toFixed(6) || '');
  }, [selectedPoint?.latitude, selectedPoint?.longitude]);

  useEffect(() => {
    if (initialCenter) setMapCenter(initialCenter);
  }, [initialCenter?.latitude, initialCenter?.longitude]);

  const tileHref = (x, y) => {
    const wrappedX = ((x % 2 ** zoom) + 2 ** zoom) % 2 ** zoom;
    return tileTemplate.replace('{z}', String(zoom)).replace('{x}', String(wrappedX)).replace('{y}', String(y));
  };

  const selectPoint = (point) => {
    setLatitudeText(point.latitude.toFixed(6));
    setLongitudeText(point.longitude.toFixed(6));
    setMapCenter(point);
    onSelect(point);
  };

  const handlePointerDown = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      centerPixel,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
    if (drag.moved) {
      setMapCenter(worldPixelToCoordinates(drag.centerPixel.x - dx, drag.centerPixel.y - dy, zoom));
    }
  };

  const handlePointerUp = (event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = centerPixel.x + (event.clientX - rect.left - rect.width / 2);
    const y = centerPixel.y + (event.clientY - rect.top - rect.height / 2);
    selectPoint(worldPixelToCoordinates(x, y, zoom));
  };

  const zoomBy = (amount) => setZoom((value) => Math.max(6, Math.min(18, value + amount)));

  return (
    <div className="space-y-2">
      <div
        ref={mapElementRef}
        role="application"
        aria-label="OpenStreetMap pin picker. Drag to pan and tap to place a pin."
        className="relative mx-auto h-[220px] w-full max-w-[360px] touch-none overflow-hidden rounded-xl border border-slate-300 bg-slate-200 cursor-crosshair"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        {Array.from({ length: cols * rows }, (_, index) => {
          const x = firstTileX + (index % cols);
          const y = firstTileY + Math.floor(index / cols);
          if (y < 0 || y >= 2 ** zoom) return null;
          return (
            <img
              key={`${zoom}-${x}-${y}`}
              src={tileHref(x, y)}
              alt=""
              draggable="false"
              className="pointer-events-none absolute h-64 w-64 max-w-none select-none"
              style={{ left: x * 256 - centerPixel.x + width / 2, top: y * 256 - centerPixel.y + height / 2 }}
            />
          );
        })}
        {marker && (
          <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full text-rose-600 drop-shadow" style={{ left: marker.x - centerPixel.x + width / 2, top: marker.y - centerPixel.y + height / 2 }}>
            <MapPin className="h-8 w-8 fill-rose-500 text-white" />
          </div>
        )}
        <div className="absolute right-2 top-2 z-20 flex flex-col overflow-hidden rounded-lg bg-white shadow">
          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => zoomBy(1)} className="h-8 w-8 font-bold text-slate-800">+</button>
          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => zoomBy(-1)} className="h-8 w-8 border-t border-slate-200 font-bold text-slate-800">−</button>
        </div>
        <span className="absolute bottom-1 right-1 z-20 rounded bg-white/90 px-1.5 py-0.5 text-[9px] text-slate-700">{config.mapAttribution || '© OpenStreetMap contributors'}</span>
      </div>
      <p className="text-[10px] text-slate-500">Zoom out to see Zimbabwe, drag to the site, then tap to place the pin. Zoom in to refine it.</p>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 items-end">
        <label className="text-[9px] font-semibold text-slate-600">Latitude
          <input type="number" step="0.000001" value={latitudeText} onChange={(event) => setLatitudeText(event.target.value)} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-[11px]" />
        </label>
        <label className="text-[9px] font-semibold text-slate-600">Longitude
          <input type="number" step="0.000001" value={longitudeText} onChange={(event) => setLongitudeText(event.target.value)} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-[11px]" />
        </label>
        <button
          type="button"
          onClick={() => {
            const latitude = Number(latitudeText);
            const longitude = Number(longitudeText);
            if (latitudeText.trim() && longitudeText.trim() && Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
              selectPoint({ latitude, longitude });
            }
          }}
          className="rounded-lg bg-slate-800 px-2.5 py-2 text-[10px] font-bold text-white"
        >
          Use pin
        </button>
      </div>
      {selectedPoint && (
        <p className={`text-[10px] font-semibold ${isWithinZimbabwe(selectedPoint.latitude, selectedPoint.longitude) ? 'text-emerald-700' : 'text-rose-700'}`}>
          Pin: {selectedPoint.latitude.toFixed(6)}, {selectedPoint.longitude.toFixed(6)}
          {!isWithinZimbabwe(selectedPoint.latitude, selectedPoint.longitude) && ' — outside the Zimbabwe service area'}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// CUSTOM SVG ARTWORK & REALISTIC CIVIC VISUALS (FALLBACK-PROOF & HIGH IMPACT)
// ============================================================================
const CivicSceneArtwork = ({ variant, isAfter = false }) => {
  if (isAfter) {
    return (
      <svg viewBox="0 0 600 450" className="w-full h-full object-cover select-none">
        <defs>
          <linearGradient id="cleanSky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#bae6fd" />
          </linearGradient>
          <linearGradient id="freshGrass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" />
            <stop offset="100%" stopColor="#15803d" />
          </linearGradient>
          <linearGradient id="cleanRoad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#475569" />
            <stop offset="100%" stopColor="#1e293b" />
          </linearGradient>
        </defs>
        <rect width="600" height="260" fill="url(#cleanSky)" />
        {/* Sun & Clouds */}
        <circle cx="510" cy="70" r="34" fill="#fde047" opacity="0.9" />
        <g fill="#ffffff" opacity="0.85">
          <ellipse cx="140" cy="75" rx="45" ry="18" />
          <ellipse cx="170" cy="70" rx="35" ry="20" />
          <ellipse cx="340" cy="95" rx="40" ry="15" />
        </g>
        {/* Distant Jacaranda / Acacia Trees */}
        <g fill="#166534">
          <circle cx="90" cy="235" r="45" />
          <circle cx="140" cy="240" r="38" />
          <circle cx="480" cy="235" r="50" />
          <circle cx="540" cy="242" r="40" />
        </g>
        {/* Lush Green Verge */}
        <rect y="250" width="600" height="80" fill="url(#freshGrass)" />
        {/* Clean Paved Street */}
        <rect y="325" width="600" height="125" fill="url(#cleanRoad)" />
        <line x1="0" y1="385" x2="600" y2="385" stroke="#facc15" strokeWidth="6" strokeDasharray="36 24" />
        {/* Freshly Painted Geo Pomona Green Skip Bin */}
        <g transform="translate(215, 225)">
          <polygon points="15,20 155,20 142,85 28,85" fill="#15803d" stroke="#052e16" strokeWidth="3" />
          <rect x="10" y="12" width="150" height="10" rx="3" fill="#22c55e" />
          <text x="85" y="55" textAnchor="middle" fill="#ffffff" fontSize="13" fontWeight="bold" fontFamily="sans-serif">
            GEO POMONA
          </text>
          <text x="85" y="70" textAnchor="middle" fill="#bbf7d0" fontSize="9" fontWeight="bold" fontFamily="sans-serif">
            CLEAN ZONE
          </text>
        </g>
        {/* Sparkles */}
        <g fill="#fef08a">
          <polygon points="180,210 184,222 196,226 184,230 180,242 176,230 164,226 176,222" />
          <polygon points="415,200 418,209 427,212 418,215 415,224 412,215 403,212 412,209" />
        </g>
        {/* Verified Cleared Stamp */}
        <g transform="translate(24, 24)">
          <rect width="176" height="34" rx="17" fill="#15803d" />
          <text x="88" y="22" textAnchor="middle" fill="#ffffff" fontSize="12" fontWeight="bold" fontFamily="sans-serif">
            ✓ CLEARED BY GEO POMONA
          </text>
        </g>
      </svg>
    );
  }

  switch (variant) {
    case 'illegal_dump':
      return (
        <svg viewBox="0 0 600 450" className="w-full h-full object-cover select-none">
          <defs>
            <linearGradient id="warmSky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fdba74" />
              <stop offset="100%" stopColor="#fef3c7" />
            </linearGradient>
            <linearGradient id="earthGround" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#92400e" />
              <stop offset="100%" stopColor="#451a03" />
            </linearGradient>
          </defs>
          <rect width="600" height="260" fill="url(#warmSky)" />
          {/* Background Buildings */}
          <rect x="30" y="130" width="110" height="130" fill="#cbd5e1" />
          <rect x="45" y="150" width="25" height="25" fill="#64748b" />
          <rect x="90" y="150" width="25" height="25" fill="#64748b" />
          <rect x="450" y="145" width="120" height="115" fill="#94a3b8" />
          {/* Ground & Road */}
          <rect y="255" width="600" height="85" fill="url(#earthGround)" />
          <rect y="335" width="600" height="115" fill="#334155" />
          {/* Trash Pile */}
          <g>
            <ellipse cx="290" cy="315" rx="165" ry="48" fill="#57534e" />
            <ellipse cx="260" cy="295" rx="115" ry="42" fill="#78716c" />
            {/* Black Refuse Bags */}
            <path d="M180,310 Q175,260 215,265 Q245,260 240,310 Z" fill="#1e293b" />
            <path d="M235,305 Q235,245 280,255 Q315,250 310,308 Z" fill="#0f172a" />
            <path d="M300,312 Q305,262 345,268 Q380,265 370,315 Z" fill="#1e293b" />
            {/* Cardboard & Plastic Debris */}
            <rect x="205" y="295" width="52" height="30" rx="3" transform="rotate(-12 205 295)" fill="#d97706" />
            <rect x="320" y="290" width="48" height="26" rx="3" transform="rotate(15 320 290)" fill="#f59e0b" />
            <circle cx="275" cy="318" r="14" fill="#38bdf8" />
            <circle cx="355" cy="322" r="12" fill="#ef4444" />
            <circle cx="195" cy="324" r="11" fill="#a3e635" />
          </g>
          {/* Warning Tag */}
          <g transform="translate(24, 24)">
            <rect width="175" height="34" rx="17" fill="#dc2626" />
            <text x="87" y="22" textAnchor="middle" fill="#ffffff" fontSize="12" fontWeight="bold" fontFamily="sans-serif">
              ⚠ UNCOLLECTED PILE
            </text>
          </g>
        </svg>
      );

    case 'alleyway':
      return (
        <svg viewBox="0 0 600 450" className="w-full h-full object-cover select-none">
          <rect width="600" height="450" fill="#1e293b" />
          {/* Alley Walls */}
          <polygon points="0,0 190,70 190,340 0,450" fill="#475569" />
          <polygon points="600,0 410,70 410,340 600,450" fill="#334155" />
          {/* Sky Gap */}
          <polygon points="190,0 410,0 410,70 190,70" fill="#7dd3fc" />
          {/* Alley Ground */}
          <polygon points="190,340 410,340 600,450 0,450" fill="#64748b" />
          {/* Overflowing Wheelie Bins */}
          <g transform="translate(215, 225)">
            <rect x="0" y="25" width="70" height="105" rx="6" fill="#166534" />
            <ellipse cx="35" cy="25" rx="38" ry="16" fill="#0f172a" />
            <rect x="95" y="35" width="70" height="95" rx="6" fill="#15803d" />
            <ellipse cx="130" cy="32" rx="40" ry="18" fill="#1e293b" />
            <rect x="20" y="10" width="35" height="20" fill="#f59e0b" transform="rotate(-18 20 10)" />
            <circle cx="120" cy="18" r="14" fill="#38bdf8" />
          </g>
          <g transform="translate(24, 24)">
            <rect width="175" height="34" rx="17" fill="#d97706" />
            <text x="87" y="22" textAnchor="middle" fill="#ffffff" fontSize="12" fontWeight="bold" fontFamily="sans-serif">
              OVERFLOWING ALLEY
            </text>
          </g>
        </svg>
      );

    case 'skip_request':
      return (
        <svg viewBox="0 0 600 450" className="w-full h-full object-cover select-none">
          <defs>
            <linearGradient id="blueprintBg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#064e3b" />
              <stop offset="100%" stopColor="#022c22" />
            </linearGradient>
          </defs>
          <rect width="600" height="450" fill="url(#blueprintBg)" />
          {/* Subtle Grid */}
          <g stroke="#10b981" strokeOpacity="0.18" strokeWidth="1">
            <line x1="0" y1="90" x2="600" y2="90" />
            <line x1="0" y1="180" x2="600" y2="180" />
            <line x1="0" y1="270" x2="600" y2="270" />
            <line x1="0" y1="360" x2="600" y2="360" />
            <line x1="150" y1="0" x2="150" y2="450" />
            <line x1="300" y1="0" x2="300" y2="450" />
            <line x1="450" y1="0" x2="450" y2="450" />
          </g>
          {/* Proposed Skip Bin Illustration */}
          <g transform="translate(175, 130)">
            <polygon
              points="20,40 230,40 205,155 45,155"
              fill="#10b981"
              fillOpacity="0.25"
              stroke="#34d399"
              strokeWidth="4"
              strokeDasharray="10 6"
            />
            <text x="125" y="95" textAnchor="middle" fill="#ecfdf5" fontSize="18" fontWeight="bold" fontFamily="sans-serif">
              PROPOSED 6m³ SKIP BIN
            </text>
            <text x="125" y="120" textAnchor="middle" fill="#6ee7b7" fontSize="13" fontFamily="sans-serif">
              COMMUNITY COLLECTION POINT
            </text>
          </g>
          <g transform="translate(24, 24)">
            <rect width="195" height="34" rx="17" fill="#059669" />
            <text x="97" y="22" textAnchor="middle" fill="#ffffff" fontSize="12" fontWeight="bold" fontFamily="sans-serif">
              💡 INFRASTRUCTURE IDEA
            </text>
          </g>
        </svg>
      );

    case 'sorting_station':
    default:
      return (
        <svg viewBox="0 0 600 450" className="w-full h-full object-cover select-none">
          <rect width="600" height="450" fill="#f0fdf4" />
          <rect y="330" width="600" height="120" fill="#dcfce7" />
          {/* 3 Color-Coded Recycling Bins */}
          <g transform="translate(105, 145)">
            {/* Plastics - Blue */}
            <rect x="0" y="30" width="105" height="155" rx="12" fill="#0284c7" />
            <rect x="-5" y="18" width="115" height="16" rx="6" fill="#0369a1" />
            <text x="52" y="110" textAnchor="middle" fill="#ffffff" fontSize="14" fontWeight="bold" fontFamily="sans-serif">
              PLASTICS
            </text>
            {/* Organics - Green */}
            <rect x="140" y="30" width="105" height="155" rx="12" fill="#16a34a" />
            <rect x="135" y="18" width="115" height="16" rx="6" fill="#15803d" />
            <text x="192" y="110" textAnchor="middle" fill="#ffffff" fontSize="14" fontWeight="bold" fontFamily="sans-serif">
              ORGANIC
            </text>
            {/* Paper/Glass - Amber */}
            <rect x="280" y="30" width="105" height="155" rx="12" fill="#d97706" />
            <rect x="275" y="18" width="115" height="16" rx="6" fill="#b45309" />
            <text x="332" y="110" textAnchor="middle" fill="#ffffff" fontSize="14" fontWeight="bold" fontFamily="sans-serif">
              PAPER/GLASS
            </text>
          </g>
          <g transform="translate(24, 24)">
            <rect width="205" height="34" rx="17" fill="#15803d" />
            <text x="102" y="22" textAnchor="middle" fill="#ffffff" fontSize="12" fontWeight="bold" fontFamily="sans-serif">
              ♻️ WASTE-TO-ENERGY SORTING
            </text>
          </g>
        </svg>
      );
  }
};

// ============================================================================
// INITIAL SEED DATA FOR ZIMBABWE SUBURBS, STORIES, AND CIVIC POSTS
// ============================================================================
const ZIM_LOCATIONS = [
  'All Zimbabwe',
  'Harare - CBD',
  'Mbare',
  'Kuwadzana',
  'Borrowdale',
  'Avondale',
  'Glen View',
  'Msasa',
  'Bulawayo',
  'Mutare',
  'Gweru'
];

const INITIAL_STORIES = [
  {
    id: 'st-1',
    zone: 'Mbare Musika',
    progress: 85,
    status: '3 Crews Active',
    tonnage: '14.2 Tonnes Cleared Today',
    update: 'Market perimeter sweep in progress. New 6m³ skip bins placed near South Entrance.',
    eta: 'Completion in 45 mins',
    color: 'from-emerald-500 to-lime-400'
  },
  {
    id: 'st-2',
    zone: 'Kuwadzana Ext',
    progress: 100,
    status: 'Zone Cleared',
    tonnage: '9.8 Tonnes Cleared',
    update: 'All 4 illegal roadside dump sites along Bulawayo Rd turnoff cleared & sanitized!',
    eta: 'Completed 1h ago',
    color: 'from-green-600 to-emerald-400'
  },
  {
    id: 'st-3',
    zone: 'Msasa Industrial',
    progress: 60,
    status: 'Compactor En Route',
    tonnage: '6.5 Tonnes Scheduled',
    update: 'Commercial recycling pickup running along Mutare Road corridor.',
    eta: 'ETA 20 mins',
    color: 'from-amber-500 to-emerald-500'
  },
  {
    id: 'st-4',
    zone: 'Pomona Plant',
    progress: 96,
    status: 'Waste-to-Energy',
    tonnage: '420 Tonnes Processed',
    update: 'Geo Pomona sorting & encapsulation cells operating at peak capacity today.',
    eta: 'Live Telemetry',
    color: 'from-teal-500 to-green-500'
  },
  {
    id: 'st-5',
    zone: 'Bulawayo CBD',
    progress: 72,
    status: 'Community Blitz',
    tonnage: '11.0 Tonnes Collected',
    update: 'Joint youth clean-up along Fife Street & 8th Ave supported by Geo Pomona trucks.',
    eta: 'Active Now',
    color: 'from-emerald-600 to-teal-400'
  }
];

const INITIAL_POSTS = [
  {
    id: 'post-1',
    username: 'tinashe_harare',
    fullName: 'Tinashe Moyo',
    avatarBg: 'bg-emerald-700',
    initials: 'TM',
    location: 'Mbare',
    landmark: 'Near Mbare Musika North Terminus',
    type: 'illegal_dump', // 'illegal_dump' | 'missed_pickup' | 'suggestion'
    status: 'cleared', // 'reported' | 'dispatched' | 'cleared'
    timestamp: '2 hours ago',
    artworkVariant: 'illegal_dump',
    customImage: null,
    hasBeforeAfter: true,
    caption:
      'Massive pile of market waste and plastics cleared within 3 hours of reporting! Big salute to the Geo Pomona rapid response crew for restoring our street. 🙌🇿🇼 #CleanZim #GeoPomona #Mbare',
    likes: 148,
    likedByMe: false,
    savedByMe: false,
    comments: [
      {
        id: 'c-101',
        user: 'rudo_zim',
        text: 'Wow that before & after difference is night and day! Keep it up!'
      },
      {
        id: 'c-102',
        user: 'geopomona_ops',
        text: 'Thank you @tinashe_harare! A dedicated skip bin has also been positioned 30m from this corner.',
        isOfficial: true
      }
    ]
  },
  {
    id: 'post-2',
    username: 'nyasha_chitsike',
    fullName: 'Nyasha Chitsike',
    avatarBg: 'bg-teal-700',
    initials: 'NC',
    location: 'Kuwadzana',
    landmark: 'Kuwadzana 4 Shopping Centre',
    type: 'illegal_dump',
    status: 'dispatched',
    timestamp: '45 mins ago',
    artworkVariant: 'alleyway',
    customImage: null,
    hasBeforeAfter: false,
    caption:
      'Alleyway behind the shops is overflowing after weekend market trading. Needs a compactor truck before the afternoon rains! 📍 Kuwadzana 4 #ZeroWaste #HarareClean',
    likes: 64,
    likedByMe: true,
    savedByMe: true,
    comments: [
      {
        id: 'c-201',
        user: 'farai_k',
        text: 'Upvoted! Passing through here every morning.'
      }
    ]
  },
  {
    id: 'post-3',
    username: 'dr_sibanda_byo',
    fullName: 'Dr. Thabo Sibanda',
    avatarBg: 'bg-slate-800',
    initials: 'TS',
    location: 'Bulawayo',
    landmark: 'Ascot Shopping Centre & Park',
    type: 'suggestion',
    status: 'reported',
    timestamp: '4 hours ago',
    artworkVariant: 'sorting_station',
    customImage: null,
    hasBeforeAfter: false,
    caption:
      'Suggestion for Geo Pomona: Can we install 3-stream color-coded recycling cages (Plastics, Organics, Glass/Paper) at major shopping centres? Schools in the area would love to partner on plastic bottle drives! 💡♻️ #EcoZim #WasteToEnergy',
    likes: 215,
    likedByMe: false,
    savedByMe: false,
    comments: [
      {
        id: 'c-301',
        user: 'kuda_green',
        text: '100% support this! Separating plastics at source makes Pomona Waste-to-Energy even more efficient.'
      }
    ]
  },
  {
    id: 'post-4',
    username: 'tariro_avondale',
    fullName: 'Tariro Gumbo',
    avatarBg: 'bg-green-800',
    initials: 'TG',
    location: 'Avondale',
    landmark: 'King George Road Corner',
    type: 'suggestion',
    status: 'dispatched',
    timestamp: '6 hours ago',
    artworkVariant: 'skip_request',
    customImage: null,
    hasBeforeAfter: false,
    caption:
      'Requesting a covered 6m³ Geo Pomona skip bin near the weekend craft market so vendors have an official drop point instead of using open trenches. #CleanHarare #GeoPomona',
    likes: 92,
    likedByMe: false,
    savedByMe: false,
    comments: []
  }
];

const QUICK_SNAP_PRESETS = [
  {
    id: 'preset-1',
    label: 'Roadside Dump Pile',
    variant: 'illegal_dump',
    defaultType: 'illegal_dump',
    desc: 'Uncollected roadside trash pile'
  },
  {
    id: 'preset-2',
    label: 'Overflowing Alleyway',
    variant: 'alleyway',
    defaultType: 'missed_pickup',
    desc: 'Full bins needing urgent pickup'
  },
  {
    id: 'preset-3',
    label: 'Skip Bin Request',
    variant: 'skip_request',
    defaultType: 'suggestion',
    desc: 'Propose a new 6m³ community skip'
  },
  {
    id: 'preset-4',
    label: 'Recycling Station',
    variant: 'sorting_station',
    defaultType: 'suggestion',
    desc: '3-bin waste separation proposal'
  }
];

const SUBURB_LEADERBOARD = [
  { suburb: 'Mbare', reports: 142, cleared: 134, rate: 94, tonnage: '186t' },
  { suburb: 'Kuwadzana', reports: 118, cleared: 109, rate: 92, tonnage: '142t' },
  { suburb: 'Harare - CBD', reports: 104, cleared: 99, rate: 95, tonnage: '128t' },
  { suburb: 'Glen View', reports: 89, cleared: 78, rate: 88, tonnage: '97t' },
  { suburb: 'Bulawayo', reports: 76, cleared: 71, rate: 93, tonnage: '84t' },
  { suburb: 'Avondale', reports: 61, cleared: 59, rate: 97, tonnage: '52t' }
];

const TOP_CITIZENS = [
  { handle: '@tinashe_harare', suburb: 'Mbare', reports: 28, points: 1450, badge: 'Pomona Platinum' },
  { handle: '@dr_sibanda_byo', suburb: 'Bulawayo', reports: 22, points: 1180, badge: 'Eco Architect' },
  { handle: '@nyasha_chitsike', suburb: 'Kuwadzana', reports: 19, points: 980, badge: 'Clean Zim Champion' },
  { handle: '@tariro_avondale', suburb: 'Avondale', reports: 15, points: 810, badge: 'Green Guardian' }
];

// ============================================================================
// MAIN APPLICATION COMPONENT
// ============================================================================
export default function App() {
  // Persistent State Initialization
  const [posts, setPosts] = useState(() => {
    try {
      const saved = localStorage.getItem('geosnap_zim_posts_v1');
      return saved ? JSON.parse(saved) : INITIAL_POSTS;
    } catch {
      return INITIAL_POSTS;
    }
  });

  const [userStats, setUserStats] = useState(() => {
    try {
      const saved = localStorage.getItem('geosnap_zim_user_v1');
      return saved
        ? JSON.parse(saved)
        : {
            handle: '@zim_citizen_you',
            fullName: 'Tendai Mukanya',
            suburb: 'Harare - CBD',
            points: 640,
            reportsCount: 7,
            suggestionsCount: 4
          };
    } catch {
      return {
        handle: '@zim_citizen_you',
        fullName: 'Tendai Mukanya',
        suburb: 'Harare - CBD',
        points: 640,
        reportsCount: 7,
        suggestionsCount: 4
      };
    }
  });

  // UI & Navigation State
  const [activeTab, setActiveTab] = useState('feed'); // 'feed' | 'hotspots' | 'profile'
  const [selectedLocation, setSelectedLocation] = useState('All Zimbabwe');
  const [feedCategory, setFeedCategory] = useState('all'); // 'all' | 'reports' | 'suggestions' | 'cleared'
  const [opsMode, setOpsMode] = useState(false);

  // Interactive Modals & Drawers
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [activeStory, setActiveStory] = useState(null);
  const [expandedComments, setExpandedComments] = useState({});
  const [commentInputs, setCommentInputs] = useState({});
  const [beforeAfterToggle, setBeforeAfterToggle] = useState({}); // postId -> boolean (true = After, false = Before)
  const [heartBurstPostId, setHeartBurstPostId] = useState(null);
  const [toastMessage, setToastMessage] = useState(null);

  // Create Post Form State
  const [newPostType, setNewPostType] = useState('illegal_dump');
  const [newPostLocation, setNewPostLocation] = useState('Mbare');
  const [suburbManuallySelected, setSuburbManuallySelected] = useState(false);
  const [newPostLandmark, setNewPostLandmark] = useState('');
  const [newPostCaption, setNewPostCaption] = useState('');
  const [selectedPreset, setSelectedPreset] = useState('illegal_dump');
  const [uploadedPhotoData, setUploadedPhotoData] = useState(null);
  const fileInputRef = useRef(null);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [photoCaptureContext, setPhotoCaptureContext] = useState(null);
  const [manualPin, setManualPin] = useState(null);
  const [initialLivePoint, setInitialLivePoint] = useState(null);
  const [isManualPinOpen, setIsManualPinOpen] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [outbox, setOutbox] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('geosnap_zim_outbox_v1') || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const syncingRef = useRef(false);
  const [syncRetry, setSyncRetry] = useState(0);
  const syncRetryTimerRef = useRef(null);
  const liveGeolocation = useLiveGeolocation(isCreateOpen);
  const liveFixInZimbabwe = liveGeolocation.position && isWithinZimbabwe(
    liveGeolocation.position.latitude,
    liveGeolocation.position.longitude
  );
  const geoPointForAddress = manualPin || (photoCaptureContext?.fix && isWithinZimbabwe(
    photoCaptureContext.fix.latitude,
    photoCaptureContext.fix.longitude
  ) ? photoCaptureContext.fix : initialLivePoint);
  const reverseGeocode = useReverseGeocode(geoPointForAddress, isCreateOpen);
  const geocodingPointKey = geoPointForAddress
    ? `${geoPointForAddress.latitude.toFixed(5)},${geoPointForAddress.longitude.toFixed(5)}`
    : '';
  const resolvedLocationAddress = reverseGeocode.coordsKey === geocodingPointKey ? reverseGeocode.address : '';

  useEffect(() => {
    if (!resolvedLocationAddress || suburbManuallySelected) return;
    const address = resolvedLocationAddress.toLowerCase();
    const match = ZIM_LOCATIONS
      .filter((location) => location !== 'All Zimbabwe')
      .sort((left, right) => right.length - left.length)
      .find((location) => address.includes(location.toLowerCase()));
    if (match) setNewPostLocation(match);
    else if (address.includes('harare')) setNewPostLocation('Harare - CBD');
  }, [resolvedLocationAddress, suburbManuallySelected]);

  useEffect(() => {
    if (!isCreateOpen) return;
    if (manualPin) {
      setLocationError(isWithinZimbabwe(manualPin.latitude, manualPin.longitude)
        ? ''
        : 'The selected pin must fall inside Zimbabwe’s service area.');
    } else if (liveGeolocation.error) {
      setLocationError('GPS is unavailable. Place a manual pin in Zimbabwe, then select the suburb / landmark.');
      setIsManualPinOpen(true);
    } else if (liveGeolocation.position && !liveFixInZimbabwe) {
      setLocationError('GPS is outside Zimbabwe. Place a manual pin in the service area.');
      setIsManualPinOpen(true);
    } else if (liveFixInZimbabwe && !manualPin && !photoCaptureContext) {
      setLocationError('');
    }
  }, [isCreateOpen, liveGeolocation.error, liveGeolocation.position?.latitude, liveGeolocation.position?.longitude, liveFixInZimbabwe, manualPin, photoCaptureContext]);

  useEffect(() => {
    if (isCreateOpen && !initialLivePoint && liveFixInZimbabwe) setInitialLivePoint(liveGeolocation.position);
  }, [isCreateOpen, initialLivePoint, liveFixInZimbabwe, liveGeolocation.position]);

  useEffect(() => {
    try {
      localStorage.setItem('geosnap_zim_posts_v1', JSON.stringify(posts));
    } catch (e) {
      // Image payloads are capped at 500 KB; storage can still be disabled or full.
    }
  }, [posts]);

  useEffect(() => {
    try {
      localStorage.setItem('geosnap_zim_outbox_v1', JSON.stringify(outbox));
    } catch {
      // Keep the in-memory queue available for the current session.
    }
  }, [outbox]);

  useEffect(() => {
    const updateOnlineState = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    return () => {
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
    };
  }, []);

  useEffect(() => {
    const recoverablePosts = outbox.map((item) => item.payload).filter(Boolean);
    if (recoverablePosts.length === 0) return;
    setPosts((current) => {
      const existingIds = new Set(current.map((post) => post.id));
      return [...current, ...recoverablePosts.filter((post) => !existingIds.has(post.id))];
    });
  }, []);

  useEffect(() => {
    let isCurrent = true;
    loadOfflineQueue().then(({ reports, outbox: indexedQueue }) => {
      if (!isCurrent) return;
      setPosts((current) => {
        const existing = new Map(current.map((post) => [post.id, post]));
        const restored = reports.map((report) => {
          const localPost = existing.get(report.id);
          return localPost
            ? { ...report, ...localPost, syncState: report.syncState === 'synced' ? 'synced' : localPost.syncState }
            : report;
        });
        const restoredIds = new Set(restored.map((post) => post.id));
        return [...restored, ...current.filter((post) => !restoredIds.has(post.id))];
      });
      setOutbox((current) => {
        const pending = new Map(current.map((item) => [item.id, item]));
        indexedQueue.forEach((item) => pending.set(item.id, { id: item.id }));
        return [...pending.values()];
      });
    }).catch(() => {
      // The app also keeps a localStorage queue for browsers without IndexedDB.
    });
    return () => { isCurrent = false; };
  }, []);

  useEffect(() => () => clearTimeout(syncRetryTimerRef.current), []);

  useEffect(() => {
    const apiBaseUrl = window.__GEOSNAP_CONFIG__?.apiBaseUrl;
    if (!isOnline || !apiBaseUrl || outbox.length === 0 || syncingRef.current) return;
    syncingRef.current = true;
    clearTimeout(syncRetryTimerRef.current);
    let shouldRetry = false;
    (async () => {
      try {
        for (const queuedReport of outbox) {
          if (!navigator.onLine) {
            shouldRetry = true;
            break;
          }
          const reportPayload = queuedReport.payload || posts.find((post) => post.id === queuedReport.id);
          if (!reportPayload) break;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 20000);
          let response;
          try {
            response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/posts`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Idempotency-Key': queuedReport.id
              },
              body: JSON.stringify(reportPayload),
              signal: controller.signal
            });
          } finally {
            clearTimeout(timeout);
          }
          if (!response.ok) {
            shouldRetry = true;
            break;
          }
          await markOfflineReportSynced(reportPayload).catch(() => {});
          setSyncRetry(0);
          setPosts((current) => current.map((post) => post.id === queuedReport.id ? { ...post, syncState: 'synced' } : post));
          setOutbox((current) => current.filter((item) => item.id !== queuedReport.id));
        }
      } catch {
        // Keep the item in the durable outbox and retry with a short backoff.
        shouldRetry = true;
      } finally {
        syncingRef.current = false;
        if (shouldRetry) {
          clearTimeout(syncRetryTimerRef.current);
          const delay = Math.min(60000, 5000 * 2 ** Math.min(syncRetry, 4));
          syncRetryTimerRef.current = setTimeout(() => setSyncRetry((attempt) => attempt + 1), delay);
        } else if (outbox.length === 0) {
          setSyncRetry(0);
        }
      }
    })();
  }, [isOnline, outbox, posts, syncRetry]);

  useEffect(() => {
    try {
      localStorage.setItem('geosnap_zim_user_v1', JSON.stringify(userStats));
    } catch (e) {
      // Ignore storage errors
    }
  }, [userStats]);

  // Helper: Show non-intrusive toast banner
  const triggerToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3200);
  };

  const openCreateModal = () => {
    setSuburbManuallySelected(false);
    setManualPin(null);
    setPhotoCaptureContext(null);
    setInitialLivePoint(null);
    setUploadedPhotoData(null);
    setLocationError('');
    setIsManualPinOpen(false);
    setIsCameraOpen(false);
    setIsCreateOpen(true);
  };

  const getCaptureContext = () => ({
    capturedAt: new Date().toISOString(),
    fix: liveGeolocation.snapshot()
  });

  const handleCapturedPhoto = async (blob, context) => {
    try {
      setUploadedPhotoData(await readBlobAsDataUrl(blob));
      setPhotoCaptureContext(context);
      const contextTime = Date.parse(context.capturedAt);
      const freshFix = context.fix && Number.isFinite(contextTime) && Math.abs(contextTime - context.fix.timestamp) <= 120000;
      if (!freshFix || !isWithinZimbabwe(context.fix.latitude, context.fix.longitude)) {
        setLocationError('A fresh in-range GPS fix was unavailable when this photo was taken. Place a pickup pin below.');
        setIsManualPinOpen(true);
      } else {
        setLocationError('');
      }
    } catch {
      triggerToast('Could not attach this photo. Please try another image.');
    }
  };

  const handleManualPinSelect = (point) => {
    setManualPin({ ...point, selectedAt: new Date().toISOString() });
    setLocationError(isWithinZimbabwe(point.latitude, point.longitude)
      ? ''
      : 'The selected pin must fall inside Zimbabwe’s service area.');
  };

  // Toggle Like / Upvote
  const handleToggleLike = (postId, forceLike = false) => {
    setPosts((prev) =>
      prev.map((post) => {
        if (post.id !== postId) return post;
        if (forceLike && post.likedByMe) return post;
        const nextLiked = forceLike ? true : !post.likedByMe;
        return {
          ...post,
          likedByMe: nextLiked,
          likes: nextLiked ? post.likes + 1 : Math.max(0, post.likes - 1)
        };
      })
    );
  };

  // Double-Tap Media to Like
  const handleDoubleTapMedia = (postId) => {
    handleToggleLike(postId, true);
    setHeartBurstPostId(postId);
    setTimeout(() => setHeartBurstPostId(null), 750);
  };

  // Toggle Bookmark / Save
  const handleToggleSave = (postId) => {
    setPosts((prev) =>
      prev.map((post) => {
        if (post.id !== postId) return post;
        const nextSaved = !post.savedByMe;
        triggerToast(nextSaved ? 'Saved to your Eco-Bookmarks' : 'Removed from Saved');
        return { ...post, savedByMe: nextSaved };
      })
    );
  };

  // Share Report / Copy Link
  const handleSharePost = (post) => {
    const shareText = `GeoSnap Zim Report (${post.location}): "${post.caption.slice(0, 70)}..." — Track via Geo Pomona Waste Management`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareText).catch(() => {});
    }
    triggerToast('WhatsApp / Civic Report link copied to clipboard!');
  };

  // Add Comment
  const handleAddComment = (postId, e) => {
    e.preventDefault();
    const text = (commentInputs[postId] || '').trim();
    if (!text) return;

    const newComment = {
      id: `c-${Date.now()}`,
      user: opsMode ? 'geopomona_ops' : userStats.handle.replace('@', ''),
      text,
      isOfficial: opsMode
    };

    setPosts((prev) =>
      prev.map((post) =>
        post.id === postId
          ? { ...post, comments: [...post.comments, newComment] }
          : post
      )
    );
    setCommentInputs((prev) => ({ ...prev, [postId]: '' }));
    setExpandedComments((prev) => ({ ...prev, [postId]: true }));
    setUserStats((prev) => ({ ...prev, points: prev.points + 10 }));
    triggerToast(opsMode ? 'Official Ops reply posted!' : 'Comment added (+10 Eco-Points)');
  };

  // Geo Pomona Ops Dispatcher Status Transitions
  const handleOpsStatusUpdate = (postId, nextStatus) => {
    setPosts((prev) =>
      prev.map((post) => {
        if (post.id !== postId) return post;
        const isNowCleared = nextStatus === 'cleared';
        const autoReply = isNowCleared
          ? {
              id: `c-ops-${Date.now()}`,
              user: 'geopomona_ops',
              text: '✅ Site cleared and sanitized by Geo Pomona Rapid Response Unit. Before/After verification uploaded.',
              isOfficial: true
            }
          : {
              id: `c-ops-${Date.now()}`,
              user: 'geopomona_ops',
              text: '🚛 Geo Pomona compactor crew dispatched to this GPS pin. ETA 35 mins.',
              isOfficial: true
            };

        return {
          ...post,
          status: nextStatus,
          hasBeforeAfter: isNowCleared ? true : post.hasBeforeAfter,
          comments: [...post.comments, autoReply]
        };
      })
    );

    if (nextStatus === 'cleared') {
      setBeforeAfterToggle((prev) => ({ ...prev, [postId]: true }));
      triggerToast('✅ Marked CLEARED! Before/After view unlocked.');
    } else {
      triggerToast('🚛 Geo Pomona Crew Dispatched to site!');
    }
  };

  // Compress and re-encode uploads too, so EXIF GPS never conflicts with the report payload.
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setIsCameraOpen(false);
    const context = getCaptureContext();
    try {
      const compressed = await compressImageSource(file);
      setUploadedPhotoData(await readBlobAsDataUrl(compressed));
      setPhotoCaptureContext(context);
      const contextTime = Date.parse(context.capturedAt);
      const freshFix = context.fix && Number.isFinite(contextTime) && Math.abs(contextTime - context.fix.timestamp) <= 120000;
      if (!freshFix || !isWithinZimbabwe(context.fix.latitude, context.fix.longitude)) {
        setLocationError('A fresh in-range GPS fix was unavailable when this photo was selected. Place a pickup pin below.');
        setIsManualPinOpen(true);
      } else {
        setLocationError('');
      }
    } catch (imageError) {
      triggerToast(imageError.message || 'Could not optimize this photo. Try a smaller image.');
    }
  };

  // Submit New Civic Report or Suggestion
  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    if (!newPostCaption.trim()) {
      triggerToast('Please add a brief description or suggestion.');
      return;
    }

    const actionTime = Date.now();
    const actionAt = new Date(actionTime).toISOString();
    const gpsFix = photoCaptureContext ? photoCaptureContext.fix : liveGeolocation.snapshot();
    const gpsReferenceTime = photoCaptureContext ? Date.parse(photoCaptureContext.capturedAt) : actionTime;
    const gpsFresh = gpsFix && Number.isFinite(gpsReferenceTime) && Math.abs(gpsReferenceTime - gpsFix.timestamp) <= 120000;
    const gpsInZimbabwe = gpsFresh && isWithinZimbabwe(gpsFix.latitude, gpsFix.longitude);
    const manualPinInZimbabwe = manualPin && isWithinZimbabwe(manualPin.latitude, manualPin.longitude);

    if (!manualPinInZimbabwe && !gpsInZimbabwe) {
      setLocationError(gpsFix && !isWithinZimbabwe(gpsFix.latitude, gpsFix.longitude)
        ? 'GPS is outside Zimbabwe. Place a pin in the Zimbabwe service area.'
        : 'A fresh GPS fix is unavailable. Place a pin on the map to continue.');
      setIsManualPinOpen(true);
      triggerToast('Choose a valid Zimbabwe pickup pin before publishing.');
      return;
    }

    setIsSubmitting(true);
    const locationSource = manualPinInZimbabwe ? 'manual_pin' : 'live_gps';
    const latitude = manualPinInZimbabwe ? manualPin.latitude : gpsFix.latitude;
    const longitude = manualPinInZimbabwe ? manualPin.longitude : gpsFix.longitude;
    const capturedAt = photoCaptureContext?.capturedAt || actionAt;
    const selectedPointKey = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
    const resolvedAddress = reverseGeocode.coordsKey === selectedPointKey
      ? reverseGeocode.address || newPostLandmark.trim() || newPostLocation
      : newPostLandmark.trim() || newPostLocation;
    let geoLocation: GeoLocationPayload;
    try {
      geoLocation = createGeoLocationPayload({
        latitude,
        longitude,
        accuracyMeters: manualPinInZimbabwe ? 0 : gpsFix.accuracy,
        resolvedAddress,
        locationSource,
        capturedAt
      });
    } catch (payloadError) {
      setIsSubmitting(false);
      setLocationError('The selected location could not be saved. Place the pin again.');
      setIsManualPinOpen(true);
      triggerToast(payloadError.message);
      return;
    }

    const createdPost = {
      id: `post-${Date.now()}`,
      username: userStats.handle.replace('@', ''),
      fullName: userStats.fullName,
      avatarBg: 'bg-emerald-600',
      initials: 'TM',
      location: newPostLocation,
      landmark: newPostLandmark.trim() || (reverseGeocode.coordsKey === selectedPointKey ? reverseGeocode.address : '') || newPostLocation,
      type: newPostType,
      status: 'reported',
      timestamp: 'Just now',
      artworkVariant: selectedPreset,
      customImage: uploadedPhotoData,
      geoLocation,
      gpsSnapshot: gpsFix ? { ...gpsFix } : null,
      syncState: 'queued',
      hasBeforeAfter: false,
      caption: newPostCaption.trim(),
      likes: 1,
      likedByMe: true,
      savedByMe: false,
      comments: []
    };

    let durablyQueued = true;
    try {
      await persistOfflineReport(createdPost);
    } catch {
      // Fall back to a localStorage outbox for browsers without working IndexedDB.
      try {
        const savedOutbox = JSON.parse(localStorage.getItem('geosnap_zim_outbox_v1') || '[]');
        const savedPosts = JSON.parse(localStorage.getItem('geosnap_zim_posts_v1') || '[]');
        localStorage.setItem('geosnap_zim_outbox_v1', JSON.stringify([
          ...(Array.isArray(savedOutbox) ? savedOutbox.filter((item) => item.id !== createdPost.id) : []),
          { id: createdPost.id, payload: createdPost }
        ]));
        localStorage.setItem('geosnap_zim_posts_v1', JSON.stringify([
          createdPost,
          ...(Array.isArray(savedPosts) ? savedPosts.filter((post) => post.id !== createdPost.id) : [])
        ]));
      } catch {
        durablyQueued = false;
      }
    }

    setPosts((prev) => [createdPost, ...prev]);
    setOutbox((prev) => [...prev, durablyQueued ? { id: createdPost.id } : { id: createdPost.id, payload: createdPost }]);
    setUserStats((prev) => ({
      ...prev,
      points: prev.points + 50,
      reportsCount: newPostType !== 'suggestion' ? prev.reportsCount + 1 : prev.reportsCount,
      suggestionsCount: newPostType === 'suggestion' ? prev.suggestionsCount + 1 : prev.suggestionsCount
    }));

    // Reset form & close modal
    setNewPostCaption('');
    setNewPostLandmark('');
    setUploadedPhotoData(null);
    setPhotoCaptureContext(null);
    setManualPin(null);
    setLocationError('');
    setIsCameraOpen(false);
    setIsManualPinOpen(false);
    setIsCreateOpen(false);
    setActiveTab('feed');
    setSelectedLocation('All Zimbabwe');
    setFeedCategory('all');
    setIsSubmitting(false);
    triggerToast(!durablyQueued
      ? 'Saved for this session, but browser storage is full. Keep GeoSnap open to sync this report.'
      : isOnline
        ? '🎉 Saved to GeoSnap Zim and queued for server sync (+50 Eco-Points)'
        : '🎉 Saved offline. It will sync when you reconnect (+50 Eco-Points)');
  };

  // Reset Demo Data
  const handleResetDemo = () => {
    setPosts(INITIAL_POSTS);
    setOutbox([]);
    clearOfflineReports().catch(() => {});
    localStorage.removeItem('geosnap_zim_outbox_v1');
    localStorage.removeItem('geosnap_zim_posts_v1');
    triggerToast('Feed restored to latest Zimbabwe civic updates');
  };

  // Filtered Feed Posts
  const filteredPosts = posts.filter((post) => {
    const locationMatch =
      selectedLocation === 'All Zimbabwe' || post.location === selectedLocation;
    if (!locationMatch) return false;

    if (feedCategory === 'reports') {
      return post.type === 'illegal_dump' || post.type === 'missed_pickup';
    }
    if (feedCategory === 'suggestions') {
      return post.type === 'suggestion';
    }
    if (feedCategory === 'cleared') {
      return post.status === 'cleared';
    }
    return true;
  });

  // Badge Helper for Post Type
  const renderTypeBadge = (type) => {
    switch (type) {
      case 'illegal_dump':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-50 text-rose-700 border border-rose-200">
            <AlertTriangle className="w-3 h-3" /> Illegal Dump
          </span>
        );
      case 'missed_pickup':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">
            <Trash2 className="w-3 h-3" /> Missed Pickup
          </span>
        );
      case 'suggestion':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <Lightbulb className="w-3 h-3" /> Suggestion
          </span>
        );
    }
  };

  // Status Pill Helper
  const renderStatusPill = (status) => {
    switch (status) {
      case 'cleared':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-600 text-white shadow-xs">
            <CheckCircle2 className="w-3 h-3" /> Cleared
          </span>
        );
      case 'dispatched':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500 text-white shadow-xs">
            <Truck className="w-3 h-3" /> Dispatched
          </span>
        );
      case 'reported':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-800 text-slate-100">
            <Clock className="w-3 h-3 text-emerald-400" /> Reported
          </span>
        );
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex justify-center font-sans">
      {/* Mobile-First App Shell (Centered Column on Desktop, Full Width on Mobile) */}
      <div className="w-full max-w-lg bg-white min-h-screen shadow-xl border-x border-slate-200 flex flex-col relative pb-20">

        {/* ====================================================================
            TOP CIVIC APP BAR (BRANDING, SUBURB FILTER, OPS DISPATCH TOGGLE)
           ==================================================================== */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200 px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            {/* Geo Pomona Civic Logo */}
            <div
              onClick={() => {
                setActiveTab('feed');
                setSelectedLocation('All Zimbabwe');
              }}
              className="flex items-center gap-2 cursor-pointer select-none"
            >
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-600 to-green-800 flex items-center justify-center text-white shadow-sm">
                <Leaf className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-1">
                  <span className="font-extrabold text-base tracking-tight text-slate-900">
                    GeoSnap
                  </span>
                  <span className="text-[10px] font-extrabold uppercase px-1.5 py-0.2 bg-emerald-100 text-emerald-800 rounded">
                    ZIM
                  </span>
                </div>
                <p className="text-[10px] font-medium text-slate-500 leading-none">
                  Geo Pomona Civic Network
                </p>
              </div>
            </div>

            {/* Right Controls: Suburb Dropdown & Ops Mode Toggle */}
            <div className="flex items-center gap-1.5">
              {/* Suburb / City Selector */}
              <div className="relative">
                <select
                  aria-label="Filter by Zimbabwe Suburb or City"
                  value={selectedLocation}
                  onChange={(e) => setSelectedLocation(e.target.value)}
                  className="appearance-none bg-slate-100 hover:bg-slate-200/80 text-slate-800 text-xs font-semibold rounded-full pl-2.5 pr-6 py-1.5 border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 max-w-[125px] truncate cursor-pointer"
                >
                  {ZIM_LOCATIONS.map((loc) => (
                    <option key={loc} value={loc}>
                      {loc}
                    </option>
                  ))}
                </select>
                <MapPin className="w-3 h-3 text-emerald-600 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>

              {/* Dispatch Ops View Toggle */}
              <button
                onClick={() => {
                  const next = !opsMode;
                  setOpsMode(next);
                  triggerToast(
                    next
                      ? '🚛 Dispatch Ops Mode ON: You can now dispatch crews & clear reports.'
                      : '👤 Switched back to Citizen Reporter View'
                  );
                }}
                title="Toggle between Citizen Reporter and Geo Pomona Ops Dispatcher"
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-bold transition-all cursor-pointer border ${
                  opsMode
                    ? 'bg-slate-900 text-emerald-400 border-slate-900 shadow-sm'
                    : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                }`}
              >
                <Truck className="w-3.5 h-3.5" />
                <span>{opsMode ? 'Ops ON' : 'Ops'}</span>
              </button>
            </div>
          </div>

          {/* Ops Mode Banner Indicator */}
          {opsMode && (
            <div className="mt-2 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] flex items-center justify-between">
              <span className="flex items-center gap-1.5 font-medium">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                Geo Pomona Dispatch Console Active
              </span>
              <span className="text-emerald-300 font-semibold">Tap actions on cards</span>
            </div>
          )}
        </header>

        {/* Non-Intrusive Toast Banner */}
        {toastMessage && (
          <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 w-[92%] max-w-md pointer-events-none">
            <div className="bg-slate-900/95 text-white text-xs font-medium px-4 py-2.5 rounded-full shadow-lg border border-slate-700 flex items-center justify-center gap-2 text-center">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>{toastMessage}</span>
            </div>
          </div>
        )}

        {/* ====================================================================
            TAB 1: INSTAGRAM-STYLE HOME FEED & STORIES BAR
           ==================================================================== */}
        {activeTab === 'feed' && (
          <main className="flex-1">
            {/* Active Cleanups / Zones Horizontal Stories Bar */}
            <section className="border-b border-slate-200 py-3 px-3 bg-slate-50/60">
              <div className="flex items-center justify-between mb-2 px-0.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  Live Cleanup Zones
                </span>
                <span className="text-[11px] font-semibold text-emerald-700">
                  Tap zone for telemetry
                </span>
              </div>
              <div className="flex items-center gap-3.5 overflow-x-auto pb-1 no-scrollbar">
                {INITIAL_STORIES.map((story) => (
                  <button
                    key={story.id}
                    onClick={() => setActiveStory(story)}
                    className="flex flex-col items-center gap-1.5 shrink-0 group cursor-pointer"
                  >
                    <div
                      className={`p-[2.5px] rounded-full bg-gradient-to-tr ${story.color} group-hover:scale-105 transition-transform`}
                    >
                      <div className="w-14 h-14 rounded-full bg-white p-0.5 flex items-center justify-center">
                        <div className="w-full h-full rounded-full bg-slate-900 text-white flex flex-col items-center justify-center">
                          <span className="text-xs font-extrabold text-emerald-400">
                            {story.progress}%
                          </span>
                          <Truck className="w-3.5 h-3.5 text-white/90 mt-0.5" />
                        </div>
                      </div>
                    </div>
                    <span className="text-[11px] font-semibold text-slate-700 max-w-[72px] truncate">
                      {story.zone}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            {/* Feed Category Filter Pills */}
            <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-slate-100 overflow-x-auto bg-white">
              {[
                { id: 'all', label: 'All Feed' },
                { id: 'reports', label: '🚨 Trash Reports' },
                { id: 'suggestions', label: '💡 Suggestions' },
                { id: 'cleared', label: '✅ Cleared' }
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setFeedCategory(tab.id)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                    feedCategory === tab.id
                      ? 'bg-emerald-700 text-white shadow-xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Scrollable Instagram-Style Cards */}
            {filteredPosts.length === 0 ? (
              <div className="py-16 px-6 text-center">
                <div className="w-14 h-14 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-3">
                  <Leaf className="w-7 h-7" />
                </div>
                <h3 className="font-bold text-slate-800 text-base">
                  No reports in this filter yet
                </h3>
                <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
                  Be the first citizen to snap a trash site or share an eco-suggestion for{' '}
                  <span className="font-semibold text-slate-700">{selectedLocation}</span>!
                </p>
                <div className="mt-4 flex justify-center gap-2">
                  <button
                    onClick={openCreateModal}
                    className="px-4 py-2 rounded-full bg-emerald-600 text-white text-xs font-bold shadow-sm hover:bg-emerald-700 cursor-pointer"
                  >
                    + Snap Report
                  </button>
                  <button
                    onClick={() => {
                      setSelectedLocation('All Zimbabwe');
                      setFeedCategory('all');
                    }}
                    className="px-4 py-2 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold hover:bg-slate-200 cursor-pointer"
                  >
                    Show All Zim
                  </button>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {filteredPosts.map((post) => {
                  const isAfterShown = !!beforeAfterToggle[post.id];
                  const areCommentsOpen = !!expandedComments[post.id];

                  return (
                    <article key={post.id} className="bg-white pb-3">
                      {/* Card Header: Avatar, Handle, Suburb Pin, Type & Status */}
                      <div className="flex items-center justify-between px-3.5 py-2.5">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`w-9 h-9 rounded-full ${post.avatarBg} text-white font-bold text-xs flex items-center justify-center shrink-0 ring-2 ring-emerald-500/30`}
                          >
                            {post.initials}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-xs text-slate-900 truncate">
                                {post.username}
                              </span>
                              <span className="text-[10px] text-slate-400">• {post.timestamp}</span>
                            </div>
                            <div className="flex items-center gap-1 text-[11px] text-slate-600 truncate">
                              <MapPin className="w-3 h-3 text-emerald-600 shrink-0" />
                              <span className="font-semibold text-emerald-800">
                                {post.location}
                              </span>
                              <span className="text-slate-400 truncate">
                                — {post.landmark}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Status Pill */}
                        <div className="shrink-0 ml-2">{renderStatusPill(post.status)}</div>
                      </div>

                      {/* Sub-Header Strip: Post Type Badge & Before/After Toggle */}
                      <div className="px-3.5 pb-2 flex items-center justify-between">
                        {renderTypeBadge(post.type)}

                        {post.hasBeforeAfter && (
                          <div className="inline-flex rounded-full bg-slate-100 p-0.5 border border-slate-200">
                            <button
                              onClick={() =>
                                setBeforeAfterToggle((prev) => ({ ...prev, [post.id]: false }))
                              }
                              className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold transition-all cursor-pointer ${
                                !isAfterShown
                                  ? 'bg-slate-800 text-white shadow-xs'
                                  : 'text-slate-600 hover:text-slate-900'
                              }`}
                            >
                              Before
                            </button>
                            <button
                              onClick={() =>
                                setBeforeAfterToggle((prev) => ({ ...prev, [post.id]: true }))
                              }
                              className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold transition-all cursor-pointer ${
                                isAfterShown
                                  ? 'bg-emerald-600 text-white shadow-xs'
                                  : 'text-slate-600 hover:text-slate-900'
                              }`}
                            >
                              ✨ After Cleanup
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Media Container (Double-Tap to Like) */}
                      <div
                        onDoubleClick={() => handleDoubleTapMedia(post.id)}
                        className="relative w-full aspect-[4/3] bg-slate-900 overflow-hidden select-none cursor-pointer group"
                      >
                        {post.customImage && !isAfterShown ? (
                          <img
                            src={post.customImage}
                            alt={post.landmark}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <CivicSceneArtwork
                            variant={post.artworkVariant}
                            isAfter={post.hasBeforeAfter && isAfterShown}
                          />
                        )}

                        {/* Double-Tap Animated Heart Burst */}
                        {heartBurstPostId === post.id && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/15 animate-fade-in">
                            <Heart className="w-20 h-20 text-white fill-rose-500 drop-shadow-lg scale-110 transition-transform" />
                          </div>
                        )}

                        {/* Subtle Double-Tap Hint */}
                        <div className="absolute bottom-2.5 right-2.5 bg-black/55 backdrop-blur-xs text-white/90 text-[10px] px-2 py-0.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                          Double-tap to upvote
                        </div>
                      </div>

                      {/* Ops Dispatcher Action Bar (Visible when Ops Mode is ON) */}
                      {opsMode && (
                        <div className="mx-3.5 mt-2.5 p-2.5 rounded-xl bg-slate-900 text-white flex items-center justify-between gap-2">
                          {post.geoLocation && (
                            <div className="min-w-0 text-[10px] leading-relaxed">
                              <span className="block font-bold text-emerald-300">{post.geoLocation.resolvedAddress || post.landmark}</span>
                              <span className="block text-slate-300">
                                {post.geoLocation.latitude.toFixed(6)}, {post.geoLocation.longitude.toFixed(6)}
                                {post.geoLocation.locationSource === 'live_gps' && ` · ±${Math.round(post.geoLocation.accuracyMeters)}m`}
                              </span>
                              <span className="block text-slate-400">Plus Code {post.geoLocation.plusCode} · {post.geoLocation.locationSource.replace('_', ' ')}</span>
                              <a
                                href={`https://www.openstreetmap.org/?mlat=${post.geoLocation.latitude}&mlon=${post.geoLocation.longitude}#map=18/${post.geoLocation.latitude}/${post.geoLocation.longitude}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-bold text-emerald-300 underline"
                              >
                                Open dispatch pin
                              </a>
                            </div>
                          )}
                          <div className="text-[11px]">
                            <span className="text-slate-400 block">Dispatch Action:</span>
                            <span className="font-bold text-emerald-400 uppercase">
                              Status: {post.status}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {post.status === 'reported' && (
                              <button
                                onClick={() => handleOpsStatusUpdate(post.id, 'dispatched')}
                                className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs flex items-center gap-1 cursor-pointer"
                              >
                                <Truck className="w-3.5 h-3.5" /> Dispatch Crew
                              </button>
                            )}
                            {post.status !== 'cleared' && (
                              <button
                                onClick={() => handleOpsStatusUpdate(post.id, 'cleared')}
                                className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs flex items-center gap-1 cursor-pointer"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" /> Mark Cleared
                              </button>
                            )}
                            {post.status === 'cleared' && (
                              <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1 px-2">
                                <Check className="w-4 h-4" /> Site Verified
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Instagram Action Bar */}
                      <div className="px-3.5 pt-2.5 pb-1.5 flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <button
                            onClick={() => handleToggleLike(post.id)}
                            className="flex items-center gap-1.5 group cursor-pointer"
                            aria-label="Upvote Report"
                          >
                            <Heart
                              className={`w-6 h-6 transition-transform active:scale-125 ${
                                post.likedByMe
                                  ? 'fill-rose-500 text-rose-500'
                                  : 'text-slate-800 group-hover:text-rose-500'
                              }`}
                            />
                            <span className="text-xs font-bold text-slate-800">
                              {post.likes}
                            </span>
                          </button>

                          <button
                            onClick={() =>
                              setExpandedComments((prev) => ({
                                ...prev,
                                [post.id]: !prev[post.id]
                              }))
                            }
                            className="flex items-center gap-1.5 text-slate-800 hover:text-emerald-700 cursor-pointer"
                            aria-label="Comments"
                          >
                            <MessageCircle className="w-6 h-6" />
                            <span className="text-xs font-bold">{post.comments.length}</span>
                          </button>

                          <button
                            onClick={() => handleSharePost(post)}
                            className="text-slate-800 hover:text-emerald-700 cursor-pointer"
                            aria-label="Share Report"
                          >
                            <Share2 className="w-5 h-5" />
                          </button>
                        </div>

                        <button
                          onClick={() => handleToggleSave(post.id)}
                          className="text-slate-800 hover:text-emerald-700 cursor-pointer"
                          aria-label="Bookmark Post"
                        >
                          <Bookmark
                            className={`w-6 h-6 ${
                              post.savedByMe ? 'fill-emerald-700 text-emerald-700' : ''
                            }`}
                          />
                        </button>
                      </div>

                      {/* Caption & Hashtags */}
                      <div className="px-3.5 text-xs leading-relaxed text-slate-800">
                        <span className="font-bold mr-1.5">{post.username}</span>
                        <span>{post.caption}</span>
                      </div>

                      {/* Expandable Comments Section */}
                      <div className="px-3.5 mt-1.5">
                        {post.comments.length > 0 && !areCommentsOpen && (
                          <button
                            onClick={() =>
                              setExpandedComments((prev) => ({ ...prev, [post.id]: true }))
                            }
                            className="text-[11px] font-medium text-slate-500 hover:text-slate-800 cursor-pointer"
                          >
                            View all {post.comments.length} comment
                            {post.comments.length > 1 ? 's' : ''}
                          </button>
                        )}

                        {areCommentsOpen && (
                          <div className="mt-2 space-y-1.5 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                            {post.comments.length === 0 ? (
                              <p className="text-[11px] text-slate-400">
                                No comments yet. Add a civic update below!
                              </p>
                            ) : (
                              post.comments.map((c) => (
                                <div key={c.id} className="text-xs leading-snug">
                                  <span
                                    className={`font-bold mr-1.5 ${
                                      c.isOfficial
                                        ? 'text-emerald-700 bg-emerald-100 px-1.5 py-0.2 rounded'
                                        : 'text-slate-900'
                                    }`}
                                  >
                                    {c.user}
                                    {c.isOfficial ? ' ✓' : ''}
                                  </span>
                                  <span className="text-slate-700">{c.text}</span>
                                </div>
                              ))
                            )}
                          </div>
                        )}

                        {/* Add Live Comment Form */}
                        <form
                          onSubmit={(e) => handleAddComment(post.id, e)}
                          className="mt-2 flex items-center gap-2"
                        >
                          <input
                            type="text"
                            value={commentInputs[post.id] || ''}
                            onChange={(e) =>
                              setCommentInputs((prev) => ({
                                ...prev,
                                [post.id]: e.target.value
                              }))
                            }
                            placeholder={
                              opsMode
                                ? 'Add official Geo Pomona dispatch note...'
                                : 'Add a comment or location tip...'
                            }
                            className="flex-1 text-xs bg-slate-100 rounded-full px-3 py-1.5 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                          />
                          <button
                            type="submit"
                            className="text-xs font-bold text-emerald-700 hover:text-emerald-800 px-2 py-1 cursor-pointer"
                          >
                            Post
                          </button>
                        </form>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </main>
        )}

        {/* ====================================================================
            TAB 2: HOTSPOTS MAP & ZIMBABWE SUBURB LEADERBOARD
           ==================================================================== */}
        {activeTab === 'hotspots' && (
          <main className="flex-1 p-4 space-y-5">
            {/* Pomona Waste-to-Energy Live Impact Banner */}
            <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-emerald-950 to-emerald-900 text-white p-4 shadow-md">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                  Geo Pomona Civic Telemetry
                </span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
                  LIVE ZIMBABWE
                </span>
              </div>
              <h2 className="text-lg font-extrabold mt-1">
                National Clean-Up & Recovery Pulse
              </h2>
              <div className="grid grid-cols-3 gap-2.5 mt-3.5">
                <div className="bg-white/10 backdrop-blur-xs rounded-xl p-2.5">
                  <span className="text-lg font-extrabold text-emerald-400 block">689t</span>
                  <span className="text-[10px] text-slate-300">Waste Diverted</span>
                </div>
                <div className="bg-white/10 backdrop-blur-xs rounded-xl p-2.5">
                  <span className="text-lg font-extrabold text-white block">93.4%</span>
                  <span className="text-[10px] text-slate-300">Clearance Rate</span>
                </div>
                <div className="bg-white/10 backdrop-blur-xs rounded-xl p-2.5">
                  <span className="text-lg font-extrabold text-amber-300 block">2.8 hrs</span>
                  <span className="text-[10px] text-slate-300">Avg Crew ETA</span>
                </div>
              </div>
            </div>

            {/* Interactive Zimbabwe Hotspot Map Visualization */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-bold text-sm text-slate-900">
                    Active Suburb Hotspot Radar
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Tap any suburb pin to filter live reports
                  </p>
                </div>
                <Navigation className="w-4 h-4 text-emerald-600" />
              </div>

              {/* Stylized Interactive SVG Map of Zimbabwe & Harare Metro Nodes */}
              <div className="relative w-full h-52 rounded-xl bg-slate-900 overflow-hidden border border-slate-800">
                <svg viewBox="0 0 400 220" className="w-full h-full">
                  {/* Radar Circles */}
                  <circle cx="200" cy="110" r="35" fill="none" stroke="#10b981" strokeOpacity="0.25" />
                  <circle cx="200" cy="110" r="70" fill="none" stroke="#10b981" strokeOpacity="0.2" />
                  <circle cx="200" cy="110" r="105" fill="none" stroke="#10b981" strokeOpacity="0.15" />
                  {/* Connecting Logistics Routes */}
                  <line x1="200" y1="110" x2="115" y2="155" stroke="#34d399" strokeWidth="1.5" strokeDasharray="4 4" />
                  <line x1="200" y1="110" x2="295" y2="125" stroke="#34d399" strokeWidth="1.5" strokeDasharray="4 4" />
                  <line x1="200" y1="110" x2="165" y2="135" stroke="#34d399" strokeWidth="1.5" strokeDasharray="4 4" />
                  <line x1="200" y1="110" x2="225" y2="65" stroke="#34d399" strokeWidth="1.5" strokeDasharray="4 4" />

                  {/* Clickable City/Suburb Nodes */}
                  {[
                    { name: 'Mbare', x: 200, y: 110, pulse: true, color: '#ef4444' },
                    { name: 'Kuwadzana', x: 155, y: 95, pulse: false, color: '#f59e0b' },
                    { name: 'Avondale', x: 225, y: 65, pulse: false, color: '#10b981' },
                    { name: 'Bulawayo', x: 115, y: 155, pulse: true, color: '#10b981' },
                    { name: 'Gweru', x: 165, y: 135, pulse: false, color: '#38bdf8' },
                    { name: 'Mutare', x: 295, y: 125, pulse: false, color: '#10b981' }
                  ].map((node) => (
                    <g
                      key={node.name}
                      onClick={() => {
                        setSelectedLocation(node.name);
                        setActiveTab('feed');
                        triggerToast(`Filtered feed to ${node.name}`);
                      }}
                      className="cursor-pointer group"
                    >
                      <circle cx={node.x} cy={node.y} r="14" fill={node.color} fillOpacity="0.22" />
                      <circle cx={node.x} cy={node.y} r="6" fill={node.color} stroke="#ffffff" strokeWidth="1.5" />
                      <text
                        x={node.x}
                        y={node.y - 11}
                        textAnchor="middle"
                        fill="#f8fafc"
                        fontSize="10"
                        fontWeight="bold"
                        fontFamily="sans-serif"
                      >
                        {node.name}
                      </text>
                    </g>
                  ))}
                </svg>
                <div className="absolute bottom-2 left-2.5 text-[10px] text-slate-400">
                  ● Red: High Priority &nbsp; ● Green: Active Fleet
                </div>
              </div>
            </div>

            {/* Suburb Clearance Leaderboard */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
              <h3 className="font-bold text-sm text-slate-900 mb-3">
                Suburb Clearance Leaderboard
              </h3>
              <div className="space-y-3">
                {SUBURB_LEADERBOARD.map((item, idx) => (
                  <div
                    key={item.suburb}
                    onClick={() => {
                      setSelectedLocation(item.suburb);
                      setActiveTab('feed');
                    }}
                    className="cursor-pointer group"
                  >
                    <div className="flex items-center justify-between text-xs mb-1">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-700 font-bold text-[11px] flex items-center justify-center">
                          {idx + 1}
                        </span>
                        <span className="font-bold text-slate-800 group-hover:text-emerald-700">
                          {item.suburb}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="font-bold text-emerald-700">{item.cleared}/{item.reports}</span>
                        <span className="text-slate-400 text-[11px] ml-1.5">({item.tonnage})</span>
                      </div>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-lime-500"
                        style={{ width: `${item.rate}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Top Citizen Contributors */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
              <h3 className="font-bold text-sm text-slate-900 mb-3">
                Top Clean Zim Contributors
              </h3>
              <div className="divide-y divide-slate-100">
                {TOP_CITIZENS.map((citizen) => (
                  <div
                    key={citizen.handle}
                    className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between"
                  >
                    <div>
                      <p className="text-xs font-bold text-slate-900">{citizen.handle}</p>
                      <p className="text-[11px] text-slate-500">
                        {citizen.suburb} • {citizen.badge}
                      </p>
                    </div>
                    <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 font-extrabold text-xs">
                      {citizen.points} pts
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </main>
        )}

        {/* ====================================================================
            TAB 3: CITIZEN ECO-POINTS & PROFILE
           ==================================================================== */}
        {activeTab === 'profile' && (
          <main className="flex-1 p-4 space-y-5">
            {/* Profile Header Card */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
              <div className="flex items-center gap-3.5">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-600 to-green-800 text-white font-extrabold text-xl flex items-center justify-center shadow-sm">
                  TM
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-1.5">
                    <h2 className="font-extrabold text-base text-slate-900">
                      {userStats.fullName}
                    </h2>
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  </div>
                  <p className="text-xs text-slate-500">{userStats.handle}</p>
                  <div className="mt-1.5 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[11px] font-bold">
                    <Award className="w-3.5 h-3.5 text-amber-600" />
                    Clean Zim Champion • Level 4
                  </div>
                </div>
              </div>

              {/* Eco-Points & Civic Metrics */}
              <div className="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-slate-100 text-center">
                <div>
                  <span className="block text-lg font-extrabold text-emerald-700">
                    {userStats.points}
                  </span>
                  <span className="text-[11px] text-slate-500 font-medium">Eco-Points</span>
                </div>
                <div>
                  <span className="block text-lg font-extrabold text-slate-900">
                    {userStats.reportsCount}
                  </span>
                  <span className="text-[11px] text-slate-500 font-medium">Trash Reports</span>
                </div>
                <div>
                  <span className="block text-lg font-extrabold text-slate-900">
                    {userStats.suggestionsCount}
                  </span>
                  <span className="text-[11px] text-slate-500 font-medium">Ideas Shared</span>
                </div>
              </div>

              {/* Progress to Next Reward */}
              <div className="mt-4 bg-slate-50 p-3 rounded-xl border border-slate-100">
                <div className="flex justify-between text-[11px] font-semibold mb-1">
                  <span className="text-slate-700">Next Milestone: Geo Pomona Plant VIP Tour</span>
                  <span className="text-emerald-700">{userStats.points} / 1000 pts</span>
                </div>
                <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-600 rounded-full transition-all"
                    style={{ width: `${Math.min(100, (userStats.points / 1000) * 100)}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Saved / Bookmarked Civic Posts */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <h3 className="font-bold text-sm text-slate-900">
                  Saved Reports & Ideas ({posts.filter((p) => p.savedByMe).length})
                </h3>
                <button
                  onClick={handleResetDemo}
                  className="text-[11px] font-semibold text-slate-500 hover:text-emerald-700 flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" /> Reset Demo Feed
                </button>
              </div>

              {posts.filter((p) => p.savedByMe).length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
                  Tap the bookmark icon on any post in the feed to save it here for quick tracking.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2.5">
                  {posts
                    .filter((p) => p.savedByMe)
                    .map((savedPost) => (
                      <div
                        key={savedPost.id}
                        onClick={() => {
                          setSelectedLocation(savedPost.location);
                          setActiveTab('feed');
                        }}
                        className="rounded-xl border border-slate-200 overflow-hidden bg-white shadow-xs cursor-pointer group"
                      >
                        <div className="aspect-[4/3] bg-slate-900 relative overflow-hidden">
                          {savedPost.customImage ? (
                            <img
                              src={savedPost.customImage}
                              alt={savedPost.location}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <CivicSceneArtwork
                              variant={savedPost.artworkVariant}
                              isAfter={savedPost.status === 'cleared'}
                            />
                          )}
                        </div>
                        <div className="p-2">
                          <p className="text-[11px] font-bold text-slate-800 truncate">
                            {savedPost.location}
                          </p>
                          <p className="text-[10px] text-slate-500 truncate">
                            {savedPost.caption}
                          </p>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </main>
        )}

        {/* ====================================================================
            BOTTOM INSTAGRAM-STYLE NAVIGATION BAR
           ==================================================================== */}
        <nav className="fixed bottom-0 w-full max-w-lg bg-white/95 backdrop-blur-md border-t border-slate-200 px-6 py-2 flex items-center justify-between z-30">
          <button
            onClick={() => setActiveTab('feed')}
            className={`flex flex-col items-center gap-0.5 cursor-pointer ${
              activeTab === 'feed' ? 'text-emerald-700' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Home className={`w-6 h-6 ${activeTab === 'feed' ? 'fill-emerald-700/15' : ''}`} />
            <span className="text-[10px] font-bold">Feed</span>
          </button>

          <button
            onClick={() => setActiveTab('hotspots')}
            className={`flex flex-col items-center gap-0.5 cursor-pointer ${
              activeTab === 'hotspots'
                ? 'text-emerald-700'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <BarChart2 className="w-6 h-6" />
            <span className="text-[10px] font-bold">Hotspots</span>
          </button>

          {/* Center Prominence "+" Snap / Report Button */}
          <button
            onClick={openCreateModal}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-gradient-to-r from-emerald-600 to-green-700 text-white font-bold text-xs shadow-md hover:shadow-lg active:scale-95 transition-all cursor-pointer"
          >
            <Camera className="w-4 h-4" />
            <span>Snap / Idea</span>
          </button>

          <button
            onClick={() => setActiveTab('profile')}
            className={`flex flex-col items-center gap-0.5 cursor-pointer ${
              activeTab === 'profile'
                ? 'text-emerald-700'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <User className={`w-6 h-6 ${activeTab === 'profile' ? 'fill-emerald-700/15' : ''}`} />
            <span className="text-[10px] font-bold">My Eco</span>
          </button>
        </nav>

        {/* ====================================================================
            MODAL 1: LIVE CLEANUP ZONE STORY VIEWER
           ==================================================================== */}
        {activeStory && (
          <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-3xl bg-slate-900 text-white border border-slate-700 overflow-hidden shadow-2xl">
              {/* Story Progress Bar */}
              <div className="p-3 pb-0">
                <div className="w-full h-1 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-400 rounded-full"
                    style={{ width: `${activeStory.progress}%` }}
                  />
                </div>
              </div>

              <div className="p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                      {activeStory.status}
                    </span>
                  </div>
                  <button
                    onClick={() => setActiveStory(null)}
                    className="p-1.5 rounded-full bg-slate-800 text-slate-300 hover:text-white cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <h3 className="text-xl font-extrabold mt-3">{activeStory.zone}</h3>
                <p className="text-xs text-emerald-300 font-semibold mt-0.5">
                  {activeStory.tonnage} • {activeStory.eta}
                </p>

                <div className="my-4 rounded-2xl overflow-hidden border border-slate-700 aspect-[4/3]">
                  <CivicSceneArtwork variant="illegal_dump" isAfter={activeStory.progress === 100} />
                </div>

                <p className="text-xs text-slate-200 leading-relaxed bg-slate-800/80 p-3 rounded-xl">
                  {activeStory.update}
                </p>

                <button
                  onClick={() => setActiveStory(null)}
                  className="mt-4 w-full py-2.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-xs cursor-pointer"
                >
                  Back to Live Feed
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ====================================================================
            MODAL 2: CREATE NEW REPORT OR COMMUNITY SUGGESTION (+)
           ==================================================================== */}
        {isCreateOpen && (
          <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="w-full max-w-lg bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto">
              {/* Modal Header */}
              <div className="sticky top-0 bg-white z-10 px-4 py-3.5 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <h2 className="font-extrabold text-base text-slate-900">
                    New GeoSnap Civic Post
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    Report a trash site or pitch an eco-idea (+50 Eco-Points)
                  </p>
                </div>
                <button
                  onClick={() => {
                    setIsCameraOpen(false);
                    setIsCreateOpen(false);
                  }}
                  className="p-2 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleCreateSubmit} className="p-4 space-y-4">
                {/* Step 1: Post Type Selector */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    1. What are you sharing?
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'illegal_dump', label: '🚨 Illegal Dump', preset: 'illegal_dump' },
                      { id: 'missed_pickup', label: '🗑️ Missed Pickup', preset: 'alleyway' },
                      { id: 'suggestion', label: '💡 Suggestion', preset: 'skip_request' }
                    ].map((opt) => (
                      <button
                        type="button"
                        key={opt.id}
                        onClick={() => {
                          setNewPostType(opt.id);
                          if (!uploadedPhotoData) setSelectedPreset(opt.preset);
                        }}
                        className={`py-2 px-2 rounded-xl text-xs font-bold border text-center transition-all cursor-pointer ${
                          newPostType === opt.id
                            ? 'bg-emerald-700 text-white border-emerald-700 shadow-xs'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Step 2: In-app camera, native capture, or upload */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-bold text-slate-700">
                      2. Take or choose a photo
                    </label>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setIsCameraOpen((open) => !open)}
                        className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 hover:text-emerald-800 cursor-pointer"
                      >
                        <Camera className="w-3.5 h-3.5" /> {isCameraOpen ? 'Close camera' : 'Open camera'}
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 hover:text-emerald-800 cursor-pointer"
                      >
                        <Upload className="w-3.5 h-3.5" /> Upload
                      </button>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </div>

                  {isCameraOpen && (
                    <CameraCapture
                      onCapture={handleCapturedPhoto}
                      getCaptureContext={getCaptureContext}
                      onClose={() => setIsCameraOpen(false)}
                    />
                  )}

                  {/* Live Preview Box */}
                  <div className="relative w-full aspect-[16/10] rounded-2xl overflow-hidden border border-slate-200 bg-slate-900">
                    {uploadedPhotoData ? (
                      <>
                        <img
                          src={uploadedPhotoData}
                          alt="Uploaded preview"
                          className="w-full h-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setUploadedPhotoData(null);
                            setPhotoCaptureContext(null);
                            setLocationError('');
                          }}
                          className="absolute top-2 right-2 px-2.5 py-1 rounded-full bg-black/70 text-white text-[11px] font-bold cursor-pointer"
                        >
                          Remove Photo
                        </button>
                      </>
                    ) : (
                      <CivicSceneArtwork variant={selectedPreset} />
                    )}
                  </div>

                  {/* 4 Quick-Snap Presets */}
                  {!uploadedPhotoData && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-2">
                      {QUICK_SNAP_PRESETS.map((preset) => (
                        <button
                          type="button"
                          key={preset.id}
                          onClick={() => {
                            setSelectedPreset(preset.variant);
                            setNewPostType(preset.defaultType);
                          }}
                          className={`p-2 rounded-xl border text-left transition-all cursor-pointer ${
                            selectedPreset === preset.variant
                              ? 'border-emerald-600 bg-emerald-50'
                              : 'border-slate-200 bg-white hover:bg-slate-50'
                          }`}
                        >
                          <span className="block text-[11px] font-bold text-slate-800 truncate">
                            {preset.label}
                          </span>
                          <span className="block text-[9px] text-slate-500 truncate">
                            {preset.desc}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Step 3: Live GPS with a manual pin fallback */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 space-y-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold text-slate-800">Live pickup / dump location</p>
                      <p className="text-[10px] text-slate-500">GPS is watched while this form is open and snapped when you take a photo or publish.</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-extrabold ${
                      liveGeolocation.error || (liveGeolocation.position && !liveFixInZimbabwe)
                        ? 'bg-rose-100 text-rose-800'
                        : liveFixInZimbabwe
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-amber-100 text-amber-800'
                    }`}>
                      {liveGeolocation.error
                        ? 'GPS Unavailable'
                        : !liveGeolocation.position
                          ? 'Acquiring GPS…'
                          : !liveFixInZimbabwe
                            ? 'Outside Zimbabwe'
                            : `GPS Locked ±${Math.round(liveGeolocation.position.accuracy)}m`}
                    </span>
                  </div>
                  {locationError && <p role="alert" className="rounded-lg bg-rose-50 px-2.5 py-2 text-[11px] font-semibold text-rose-800">{locationError}</p>}
                  {reverseGeocode.loading && <p className="text-[10px] text-amber-700">Resolving suburb and street…</p>}
                  {resolvedLocationAddress && <p className="text-[10px] text-slate-700"><span className="font-bold">Resolved address:</span> {resolvedLocationAddress}</p>}
                  {reverseGeocode.error && <p className="text-[10px] text-amber-700">Address lookup is unavailable. The selected suburb / landmark and Plus Code will still be saved.</p>}
                  {(manualPin || photoCaptureContext?.fix || initialLivePoint) && (() => {
                    const shownPoint = manualPin || photoCaptureContext?.fix || initialLivePoint;
                    if (!Number.isFinite(shownPoint.latitude) || !Number.isFinite(shownPoint.longitude)) return null;
                    return <p className="text-[10px] text-slate-600"><span className="font-bold">Plus Code:</span> {encodePlusCode(shownPoint.latitude, shownPoint.longitude)}</p>;
                  })()}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setIsManualPinOpen((open) => !open)} className="rounded-full border border-emerald-700 px-3 py-1.5 text-[10px] font-bold text-emerald-800">
                      {isManualPinOpen ? 'Hide map pin' : manualPin ? 'Adjust map pin' : 'Set / adjust map pin'}
                    </button>
                    {manualPin && liveFixInZimbabwe && <button type="button" onClick={() => { setManualPin(null); setLocationError(''); }} className="rounded-full border border-slate-300 px-3 py-1.5 text-[10px] font-bold text-slate-700">Use live GPS</button>}
                    {manualPin && <span className="self-center text-[10px] font-bold text-emerald-800">Using manual pin</span>}
                  </div>
                  {isManualPinOpen && (
                    <ManualPinPicker
                      initialCenter={initialLivePoint || (liveFixInZimbabwe ? liveGeolocation.position : HARARE_COORDINATES)}
                      selectedPoint={manualPin || photoCaptureContext?.fix || (liveFixInZimbabwe ? liveGeolocation.position : null)}
                      onSelect={handleManualPinSelect}
                    />
                  )}
                </div>

                {/* Suburb and optional landmark */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      4. City / Suburb
                    </label>
                    <select
                      value={newPostLocation}
                      onChange={(e) => {
                        setSuburbManuallySelected(true);
                        setNewPostLocation(e.target.value);
                      }}
                      className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      {ZIM_LOCATIONS.filter((l) => l !== 'All Zimbabwe').map((loc) => (
                        <option key={loc} value={loc}>
                          {loc}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Street / Landmark
                    </label>
                    <input
                      type="text"
                      value={newPostLandmark}
                      onChange={(e) => setNewPostLandmark(e.target.value)}
                      placeholder="e.g., Corner Samora Machel & 4th"
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                </div>

                {/* Step 4: Caption / Suggestion Details */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                      5. Description or Suggestion Details
                  </label>
                  <textarea
                    rows={3}
                    value={newPostCaption}
                    onChange={(e) => setNewPostCaption(e.target.value)}
                    placeholder={
                      newPostType === 'suggestion'
                        ? 'Describe your idea for skip bins, recycling drop-offs, or collection schedules...'
                        : 'Describe the waste type, accessibility for Geo Pomona trucks, and urgency...'
                    }
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                {/* Submit CTA */}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-3 rounded-full bg-gradient-to-r from-emerald-600 to-green-700 hover:from-emerald-700 hover:to-green-800 text-white font-extrabold text-xs shadow-md cursor-pointer flex items-center justify-center gap-2 disabled:cursor-wait disabled:opacity-60"
                >
                  <Send className="w-4 h-4" />
                  <span>{isSubmitting ? 'Saving report…' : 'Publish to GeoSnap Zim Feed'}</span>
                </button>
                <p className="text-center text-[10px] text-slate-500">
                  {isOnline ? `${outbox.length} report${outbox.length === 1 ? '' : 's'} waiting for server sync` : 'Offline: reports are queued on this device'}
                </p>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
