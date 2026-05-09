import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertTriangle, Camera, MapPin, Phone, Package, ShoppingCart,
  UtensilsCrossed, Bike, Car, User, CheckCircle, X, RefreshCw,
  MapPinned, ArrowDown, Shield, Navigation, Clock, Zap,
  ChevronRight, Eye, Truck, WifiOff, MessageSquare, ChevronDown, ChevronUp,
} from "lucide-react";
import { SafeImage } from "../components/ui/SafeImage";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
/* The Leaflet default-marker icon patch is applied once in src/main.tsx so it
   covers every map (Active trip, MiniMap, dashboard widgets) before any
   Leaflet instance is constructed. No per-page call is needed here. */
import { api, apiFetch } from "../lib/api";
import { riderIsDev } from "../lib/envValidation";
import { logRideEvent } from "../lib/rideUtils";
import { useState, useRef, useEffect, Component, type ReactNode, type ErrorInfo } from "react";
import { usePlatformConfig } from "../lib/useConfig";
import { useAuth } from "../lib/auth";
import { useLanguage } from "../lib/useLanguage";
import { useSocket } from "../lib/socket";
import { tDual, type TranslationKey } from "@workspace/i18n";
import { enqueue, registerDrainHandler, type QueuedPing } from "../lib/gpsQueue";
import { enqueueAction } from "../lib/offline/queueManager";

class MapErrorBoundary extends Component<{ children: ReactNode; fallbackMsg?: string }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(_: Error, info: ErrorInfo) { if (riderIsDev) console.error("MapErrorBoundary caught:", _, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
          <AlertTriangle size={20} className="text-red-400 mx-auto mb-2" />
          <p className="text-sm font-semibold text-red-600">{this.props.fallbackMsg ?? "Map/route could not load"}</p>
          <button onClick={() => this.setState({ hasError: false })} className="mt-2 text-xs text-indigo-500 font-bold underline">Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* Leaflet default marker icons are patched globally in src/main.tsx. */

/* ── Tile config hook for rider map ── */
function useRiderTileConfig() {
  const [tile, setTile] = useState({ url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', provider: "osm" });
  const [tileConfigError, setTileConfigError] = useState(false);
  useEffect(() => {
    apiFetch(`/maps/config?app=rider`)
      .then((d: any) => {
        const cfg = d?.data ?? d;
        const prov = cfg?.provider ?? "osm";
        const tok  = cfg?.token ?? "";
        if (prov === "mapbox" && tok) {
          setTile({ url: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${tok}`, attribution: '© <a href="https://www.mapbox.com/">Mapbox</a> © OpenStreetMap', provider: "mapbox" });
        } else if (prov === "google" && tok) {
          setTile({ url: `https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&key=${tok}`, attribution: "© Google Maps", provider: "google" });
        } else if (prov === "locationiq" && tok) {
          setTile({ url: `https://{s}.locationiq.com/v3/street/r/{z}/{x}/{y}.png?key=${tok}`, attribution: '© <a href="https://locationiq.com">LocationIQ</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', provider: "locationiq" });
        }
      })
      .catch((e: unknown) => {
        console.error("[RiderMap] Map config fetch failed — falling back to OSM:", e);
        setTileConfigError(true);
      });
  }, []);
  return { ...tile, hasError: tileConfigError };
}

function AutoFitMap({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  const validPositions = positions.filter(p => p != null && p[0] != null && p[1] != null);
  useEffect(() => {
    if (!validPositions.length) return;
    if (validPositions.length === 1) { map.setView(validPositions[0]!, 15); return; }
    map.fitBounds(L.latLngBounds(validPositions), { padding: [30, 30], maxZoom: 16 });
  }, [validPositions.map(p => p.join(",")).join("|")]);
  return null;
}

const pickupIcon = L.divIcon({ className: "", iconSize: [28, 28], iconAnchor: [14, 28],
  html: `<div style="width:28px;height:28px;display:flex;align-items:flex-end;justify-content:center;">
    <div style="background:#16a34a;border-radius:50% 50% 50% 0;transform:rotate(-45deg);width:22px;height:22px;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.35);"></div>
  </div>` });

const dropIcon = L.divIcon({ className: "", iconSize: [28, 28], iconAnchor: [14, 28],
  html: `<div style="width:28px;height:28px;display:flex;align-items:flex-end;justify-content:center;">
    <div style="background:#dc2626;border-radius:50% 50% 50% 0;transform:rotate(-45deg);width:22px;height:22px;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.35);"></div>
  </div>` });

const riderIcon = L.divIcon({ className: "", iconSize: [32, 32], iconAnchor: [16, 16],
  html: `<div style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;">
    <div style="background:#2563eb;border-radius:50%;width:20px;height:20px;border:3px solid white;box-shadow:0 0 0 4px rgba(37,99,235,0.25);">
    </div>
  </div>` });

/* ── RideRouteMap: visual map panel for active rides/deliveries ── */
function RideRouteMap({
  pickupLat, pickupLng, pickupLabel,
  dropLat, dropLng, dropLabel,
  riderLat, riderLng,
  polyline,
}: {
  pickupLat: number; pickupLng: number; pickupLabel?: string;
  dropLat: number; dropLng: number; dropLabel?: string;
  riderLat?: number | null; riderLng?: number | null;
  polyline?: Array<{ lat: number; lng: number }>;
}) {
  const tile = useRiderTileConfig();
  const { config } = usePlatformConfig();
  const [open, setOpen] = useState(false);

  /* Fallback map center from admin branding config — default Muzaffarabad, AJK */
  const fallbackCenter: [number, number] = [
    config.branding?.mapCenterLat ?? 34.37,
    config.branding?.mapCenterLng ?? 73.47,
  ];

  const isValidCoord = (lat: number, lng: number) =>
    Number.isFinite(lat) && Number.isFinite(lng) && !(Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001);

  const positions: [number, number][] = [
    [pickupLat, pickupLng],
    [dropLat, dropLng],
    ...(riderLat != null && riderLng != null ? [[riderLat, riderLng] as [number, number]] : []),
  ];

  const mapCenter: [number, number] = isValidCoord(pickupLat, pickupLng)
    ? [pickupLat, pickupLng]
    : fallbackCenter;

  const polyPositions: [number, number][] = polyline
    ? polyline.map(p => [p.lat, p.lng])
    : [[pickupLat, pickupLng], [dropLat, dropLng]];

  return (
    <div className="border border-blue-200 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-blue-50 to-sky-50 text-left"
      >
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-sky-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-blue-200">
          <MapPin size={14} className="text-white" />
        </div>
        <div className="flex-1">
          <p className="text-xs font-black text-gray-900 uppercase tracking-wide">Route Map</p>
          <p className="text-[11px] text-blue-600">{open ? "Tap to collapse" : "Tap to view map"} · {tile.provider.toUpperCase()}</p>
        </div>
        {open ? <ChevronUp size={16} className="text-blue-500" /> : <ChevronDown size={16} className="text-blue-500" />}
      </button>
      {tile.hasError && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
          <AlertTriangle size={13} className="text-amber-500 flex-shrink-0" />
          <p className="text-[11px] text-amber-700 font-medium">Map config unavailable — using standard OpenStreetMap tiles.</p>
        </div>
      )}
      {open && (
        <div style={{ height: 240 }}>
          <MapContainer
            center={mapCenter}
            zoom={13}
            style={{ height: "100%", width: "100%" }}
            scrollWheelZoom={false}
            zoomControl={true}
          >
            <TileLayer url={tile.url} attribution={tile.attribution} maxZoom={19} />
            <AutoFitMap positions={positions} />
            <Marker position={[pickupLat, pickupLng]} icon={pickupIcon}>
              <Popup><span className="text-xs font-bold text-green-700">📍 {pickupLabel ?? "Pickup"}</span></Popup>
            </Marker>
            <Marker position={[dropLat, dropLng]} icon={dropIcon}>
              <Popup><span className="text-xs font-bold text-red-700">🎯 {dropLabel ?? "Drop-off"}</span></Popup>
            </Marker>
            {riderLat != null && riderLng != null && (
              <Marker position={[riderLat, riderLng]} icon={riderIcon}>
                <Popup><span className="text-xs font-bold text-blue-700">🏍️ You</span></Popup>
              </Marker>
            )}
            {polyPositions.length >= 2 && (
              <Polyline positions={polyPositions} color="#3b82f6" weight={4} opacity={0.8} />
            )}
          </MapContainer>
        </div>
      )}
    </div>
  );
}

function SkeletonBlock({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-gray-200 rounded-xl ${className || ""}`} />;
}

function SkeletonActive() {
  return (
    <div className="bg-[#F5F6F8] min-h-screen">
      <div className="bg-gradient-to-br from-gray-900 via-gray-900 to-gray-800 px-5 pb-8 rounded-b-[2rem] relative overflow-hidden"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 3.5rem)" }}>
        <div className="absolute -top-20 -right-20 w-72 h-72 rounded-full bg-green-500/[0.04]"/>
        <div className="absolute bottom-10 -left-16 w-56 h-56 rounded-full bg-white/[0.02]"/>
        <div className="relative flex items-center justify-between">
          <div className="space-y-2">
            <SkeletonBlock className="h-7 w-40 !bg-white/10" />
            <SkeletonBlock className="h-4 w-56 !bg-white/10" />
          </div>
          <SkeletonBlock className="w-20 h-16 rounded-2xl !bg-white/[0.06]" />
        </div>
      </div>
      <div className="px-4 py-4 space-y-4">
        <div className="bg-white rounded-3xl shadow-sm overflow-hidden">
          <SkeletonBlock className="h-16 !rounded-none" />
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between px-4">
              {[1,2,3].map(i => (
                <div key={i} className="flex flex-col items-center gap-2">
                  <SkeletonBlock className="w-10 h-10 !rounded-full" />
                  <SkeletonBlock className="h-2 w-14" />
                </div>
              ))}
            </div>
            <SkeletonBlock className="h-2 mx-6" />
          </div>
        </div>
        <div className="bg-white rounded-3xl shadow-sm overflow-hidden">
          <SkeletonBlock className="h-12 !rounded-none" />
          <div className="p-4 space-y-3">
            <SkeletonBlock className="h-20" />
            <SkeletonBlock className="h-16" />
            <div className="grid grid-cols-2 gap-2">
              <SkeletonBlock className="h-12" />
              <SkeletonBlock className="h-12" />
            </div>
            <SkeletonBlock className="h-14" />
          </div>
        </div>
      </div>
    </div>
  );
}

function useElapsedTimer(startIso?: string | null) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startIso) { setElapsed(0); return; }
    const base = new Date(startIso).getTime();
    if (isNaN(base)) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor((Date.now() - base) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startIso]);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const label = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  const urgent = elapsed > 1200;
  return { label, elapsed, urgent };
}

function formatCurrency(n: number, currencySymbol = "Rs.") { return `${currencySymbol} ${Math.round(n).toLocaleString()}`; }

function ElapsedBadge({ startIso }: { startIso?: string | null }) {
  const { label, urgent, elapsed } = useElapsedTimer(startIso);
  if (!startIso) return null;
  const progress = Math.min(elapsed / 3600, 1);
  return (
    <div className={`relative flex flex-col items-center px-4 py-2.5 rounded-2xl backdrop-blur-sm border ${urgent ? "bg-red-500/90 border-red-400/30 shadow-lg shadow-red-500/20" : "bg-white/[0.06] border-white/[0.06]"}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <Clock size={10} className={urgent ? "text-red-200" : "text-white/40"}/>
        <span className={`text-[9px] font-bold uppercase tracking-widest ${urgent ? "text-red-200" : "text-white/40"}`}>Elapsed</span>
      </div>
      <span className={`text-white font-black text-lg leading-none tabular-nums ${urgent ? "animate-pulse" : ""}`}>{label}</span>
      <div className="w-full h-1 bg-white/10 rounded-full mt-1.5 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-1000 ${urgent ? "bg-red-300" : "bg-green-400"}`}
          style={{ width: `${progress * 100}%` }}/>
      </div>
    </div>
  );
}

function buildMapsDeepLink(lat: number, lng: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "#";
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  if (isIOS) {
    return `comgooglemaps://?daddr=${lat},${lng}&directionsmode=driving`;
  }
  const isAndroid = /Android/i.test(ua);
  if (isAndroid) {
    return `geo:${lat},${lng}?q=${lat},${lng}`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}

function NavButton({ label, lat, lng, address, color = "blue" }: {
  label: string; lat?: number | null; lng?: number | null; address?: string | null; color?: "blue" | "green" | "orange";
}) {
  const validCoords = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng);
  const href = validCoords
    ? buildMapsDeepLink(lat!, lng!)
    : address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
    : null;
  if (!href || href === "#") return null;
  const styles = {
    blue:   "from-blue-500 to-indigo-600 shadow-blue-200",
    green:  "from-green-500 to-emerald-600 shadow-green-200",
    orange: "from-orange-500 to-amber-600 shadow-amber-200",
  };
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className={`flex items-center justify-center gap-2 bg-gradient-to-r ${styles[color]} text-white text-sm font-bold px-4 py-3 rounded-xl transition-all active:scale-[0.97] shadow-md`}>
      <Navigation size={14}/> {label}
    </a>
  );
}

const SOS_RESET_MS = 5 * 60 * 1000; /* 5 minutes — allow rider to re-send if still in danger */

function SosButton({ rideId, riderPos, T, showToast }: { rideId?: string | null; riderPos?: { lat: number; lng: number } | null; T: (key: TranslationKey) => string; showToast: (msg: string, isError?: boolean) => void }) {
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [noLocWarning, setNoLocWarning] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sent) return;
    resetTimerRef.current = setTimeout(() => setSent(false), SOS_RESET_MS);
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, [sent]);

  const fireSos = async (lat?: number, lng?: number) => {
    const hasCoords = lat != null && lng != null &&
      Number.isFinite(lat) && Number.isFinite(lng) &&
      !(Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001);
    await apiFetch("/rider/sos", {
      method: "POST",
      body: JSON.stringify({
        rideId: rideId ?? null,
        ...(hasCoords ? { latitude: lat, longitude: lng } : {}),
      }),
      headers: { "Content-Type": "application/json" },
    });
    setSent(true);
    setNoLocWarning(false);
  };

  return (
    <>
    {noLocWarning && (
      <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 mb-2 text-xs text-yellow-800 font-medium">
        <p className="font-bold mb-1">Location unavailable</p>
        <p>Your GPS position could not be determined. SOS will be sent without location — admin will contact you by phone.</p>
        <div className="flex gap-2 mt-2">
          <button onClick={async () => { setLoading(true); try { await fireSos(); } catch { showToast("SOS failed — call emergency contacts directly", true); } setLoading(false); }}
            disabled={loading} className="bg-red-600 text-white text-xs font-bold px-3 py-1.5 rounded-lg disabled:opacity-60">
            Send SOS anyway
          </button>
          <button onClick={() => setNoLocWarning(false)} className="bg-gray-200 text-gray-600 text-xs font-bold px-3 py-1.5 rounded-lg">
            Cancel
          </button>
        </div>
      </div>
    )}
    <button
      onClick={async () => {
        if (sent || loading) return;
        setLoading(true);
        try {
          let lat = riderPos?.lat;
          let lng = riderPos?.lng;
          if (!lat || !lng) {
            try {
              const pos = await new Promise<GeolocationPosition>((res, rej) => {
                navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000, maximumAge: 10000 });
              });
              lat = pos.coords.latitude;
              lng = pos.coords.longitude;
            } catch {}
          }
          const hasCoords = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng) &&
            !(Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001);
          if (!hasCoords) {
            setNoLocWarning(true);
            setLoading(false);
            return;
          }
          await fireSos(lat!, lng!);
        } catch {
          showToast("SOS request failed — please call emergency contacts directly", true);
        }
        setLoading(false);
      }}
      disabled={sent || loading || noLocWarning}
      className={`flex items-center justify-center gap-2 self-end px-5 py-2.5 rounded-xl font-black text-sm transition-all shadow-lg ${sent ? "bg-gray-200 text-gray-500 cursor-default shadow-none" : "text-white active:scale-[0.96] shadow-red-400/40"}`}
      style={sent ? undefined : { backgroundColor: "#FF2D2D", boxShadow: "0 4px 14px rgba(255,45,45,0.45)" }}
    >
      <AlertTriangle size={15} />
      {loading ? T("sending") : sent ? T("sosSent") : T("sosEmergency")}
    </button>
    </>
  );
}

type OsrmStep = {
  instruction: string;
  streetName: string;
  distanceM: number;
  durationSec: number;
  maneuverLat: number | null;
  maneuverLng: number | null;
};
type OsrmRoute = { distanceM: number; durationSec: number; steps: OsrmStep[]; geometry?: Array<{ lat: number; lng: number }> };

/* Off-route threshold: reroute if rider is >150 m from nearest geometry point */
const REROUTE_THRESHOLD_M = 150;
/* Step advance threshold: advance to next step if within 30 m of its maneuver point */
const STEP_ADVANCE_M = 30;

function TurnByTurnPanel({ fromLat, fromLng, toLat, toLng, label, riderLat, riderLng }: {
  fromLat: number; fromLng: number; toLat: number; toLng: number; label: string;
  riderLat?: number | null; riderLng?: number | null;
}) {
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [route, setRoute] = useState<OsrmRoute | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const stepListRef = useRef<HTMLDivElement | null>(null);
  const rerouteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRerouteTimeRef = useRef<number>(0);
  const fetchAbortRef = useRef<AbortController | null>(null);
  /* Minimum interval between reroute API calls (30 seconds) */
  const REROUTE_COOLDOWN_MS = 30_000;

  const fetchRoute = async (lat?: number, lng?: number) => {
    /* Cancel any in-flight OSRM request before starting a new one */
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
    }
    const abortController = new AbortController();
    fetchAbortRef.current = abortController;

    setLoading(true);
    setError(null);
    const startLat = lat ?? fromLat;
    const startLng = lng ?? fromLng;
    try {
      const data = await apiFetch(
        `/rider/osrm-route?fromLat=${startLat}&fromLng=${startLng}&toLat=${toLat}&toLng=${toLng}`,
        { signal: abortController.signal }
      ) as OsrmRoute & { error?: string };
      if (data.error) { setError(data.error); return; }
      setRoute(data);
      setCurrentStep(0);
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== "AbortError") {
        setError(e.message || "Could not fetch route");
      }
    } finally {
      if (!abortController.signal.aborted) setLoading(false);
    }
  };

  /* Real-time step progression: advance current step as rider position updates */
  useEffect(() => {
    if (!route || riderLat == null || riderLng == null) return;

    /* Auto-advance steps when rider is close to the next step's maneuver point */
    const steps = route.steps;
    let newStep = currentStep;
    for (let i = currentStep; i < steps.length - 1; i++) {
      const step = steps[i + 1]!;
      if (step.maneuverLat != null && step.maneuverLng != null) {
        const distM = haversineDistance(riderLat, riderLng, step.maneuverLat, step.maneuverLng) * 1000;
        if (distM <= STEP_ADVANCE_M) {
          newStep = i + 1;
        }
      }
    }
    if (newStep !== currentStep) {
      setCurrentStep(newStep);
      /* Scroll active step into view */
      const el = stepListRef.current?.querySelector(`[data-step="${newStep}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    /* Off-route detection: measure distance from nearest geometry point */
    if (route.geometry && route.geometry.length > 0) {
      let minDistM = Infinity;
      for (const pt of route.geometry) {
        const d = haversineDistance(riderLat, riderLng, pt.lat, pt.lng) * 1000;
        if (d < minDistM) minDistM = d;
      }
      if (minDistM > REROUTE_THRESHOLD_M) {
        /* Debounce: only reroute if off-route for 5+ seconds continuously,
           and only if the cooldown since the last reroute has elapsed. */
        if (!rerouteTimerRef.current) {
          rerouteTimerRef.current = setTimeout(() => {
            rerouteTimerRef.current = null;
            const now = Date.now();
            if (now - lastRerouteTimeRef.current >= REROUTE_COOLDOWN_MS) {
              lastRerouteTimeRef.current = now;
              fetchRoute(riderLat, riderLng);
            }
          }, 5000);
        }
      } else {
        if (rerouteTimerRef.current) {
          clearTimeout(rerouteTimerRef.current);
          rerouteTimerRef.current = null;
        }
      }
    }
  }, [riderLat, riderLng, route, currentStep]);

  /* Cleanup reroute timer on unmount */
  useEffect(() => () => {
    if (rerouteTimerRef.current) clearTimeout(rerouteTimerRef.current);
  }, []);

  const distKm = route ? (route.distanceM < 1000 ? `${route.distanceM}m` : `${(route.distanceM / 1000).toFixed(1)} km`) : "";
  const etaMin = route ? Math.max(1, Math.round(route.durationSec / 60)) : 0;
  const currentInstruction = route?.steps[currentStep]?.instruction ?? null;

  return (
    <div className="border border-indigo-200 rounded-2xl overflow-hidden">
      <button
        onClick={() => {
          if (!open && !route) fetchRoute();
          setOpen(o => !o);
        }}
        className="w-full flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-indigo-50 to-blue-50 text-left"
      >
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-indigo-200">
          <Navigation size={14} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-black text-gray-900">Turn-by-Turn to {label}</p>
          {route && currentInstruction && (
            <p className="text-xs text-indigo-600 font-semibold truncate">{currentInstruction}</p>
          )}
          {route && !currentInstruction && <p className="text-xs text-indigo-500 font-semibold">{distKm} · ~{etaMin} min</p>}
          {!route && <p className="text-xs text-gray-400">Tap for directions</p>}
        </div>
        <span className="text-indigo-400 text-xs font-bold">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-4 pb-3">
          {loading && (
            <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
              <div className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
              {T("fetchingRoute")}
            </div>
          )}
          {error && (
            <div className="py-3 text-sm text-red-500 flex items-center gap-2">
              <AlertTriangle size={13} /> {error}
              <button onClick={() => fetchRoute()} className="underline text-indigo-500 ml-1">{T("retry")}</button>
            </div>
          )}
          {route && !loading && (
            <>
              <div className="flex items-center justify-between pt-2 pb-1">
                <span className="text-xs text-gray-400">{distKm} · ~{etaMin} min · Step {currentStep + 1}/{route.steps.length}</span>
                <button
                  onClick={() => fetchRoute(riderLat ?? undefined, riderLng ?? undefined)}
                  className="text-xs text-indigo-500 font-semibold flex items-center gap-1 hover:underline"
                >
                  <RefreshCw size={10} /> Reroute
                </button>
              </div>
              <div ref={stepListRef} className="space-y-1.5 max-h-56 overflow-y-auto">
                {route.steps.map((step, i) => {
                  const isActive = i === currentStep;
                  const isPast = i < currentStep;
                  return (
                    <div
                      key={i}
                      data-step={i}
                      className={`flex items-start gap-2 text-sm py-1.5 border-b border-gray-100 last:border-0 rounded-lg transition-colors ${isActive ? "bg-indigo-50 px-2 -mx-2" : ""} ${isPast ? "opacity-40" : ""}`}
                    >
                      <div className={`w-6 h-6 flex-shrink-0 rounded-full font-bold text-[10px] flex items-center justify-center mt-0.5 ${isActive ? "bg-indigo-500 text-white" : "bg-indigo-100 text-indigo-600"}`}>{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <p className={`font-semibold leading-tight ${isActive ? "text-indigo-700" : "text-gray-800"}`}>{step.instruction}</p>
                        {step.streetName && <p className="text-xs text-gray-400 mt-0.5">{step.streetName}</p>}
                      </div>
                      <span className="text-xs text-gray-400 flex-shrink-0 mt-0.5">
                        {step.distanceM < 1000 ? `${step.distanceM}m` : `${(step.distanceM / 1000).toFixed(1)}km`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CallButton({ name, phone, label }: { name?: string | null; phone?: string | null; label?: string }) {
  if (!phone) return null;
  return (
    <a href={`tel:${phone}`}
      className="flex items-center justify-center gap-2 bg-gradient-to-r from-green-500 to-emerald-600 text-white text-sm font-bold px-4 py-3 rounded-xl shadow-md shadow-green-200 transition-all active:scale-[0.97]">
      <Phone size={14}/> {label || `Call ${name || "Customer"}`}
    </a>
  );
}

function ChatButton({ name }: { name?: string | null }) {
  const [, navigate] = useLocation();
  return (
    <button
      onClick={() => navigate("/chat")}
      className="flex items-center justify-center gap-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white text-sm font-bold px-4 py-3 rounded-xl shadow-md shadow-blue-200 transition-all active:scale-[0.97]">
      <MessageSquare size={14}/> Chat {(name || "").split(" ")[0] || "Customer"}
    </button>
  );
}

type OrderItem = { name: string; quantity: number; price: number };

const ORDER_STEPS  = ["store",    "picked_up",  "delivered"];
const ORDER_STEP_ICONS = [
  <ShoppingCart key="store" size={16}/>,
  <Package      key="picked" size={16}/>,
  <CheckCircle  key="done"  size={16}/>,
];

const RIDE_STEPS  = ["accepted", "arrived", "in_transit", "completed"];
const RIDE_STEP_ICONS = [
  <Zap key="accept" size={14}/>,
  <MapPin key="arrive" size={14}/>,
  <Car key="transit" size={14}/>,
  <CheckCircle key="done" size={14}/>,
];

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function EstimatedArrivalBadge({ riderPos, pickupLat, pickupLng, vehicleType }: {
  riderPos: { lat: number; lng: number } | null;
  pickupLat?: number | null;
  pickupLng?: number | null;
  vehicleType?: string | null;
}) {
  if (!riderPos || pickupLat == null || pickupLng == null) return null;
  const distKm = haversineDistance(riderPos.lat, riderPos.lng, pickupLat, pickupLng);
  const speedKmh = vehicleType === "car" ? 30
    : vehicleType === "bike" ? 25
    : vehicleType === "rickshaw" ? 20
    : vehicleType === "daba" ? 20
    : 22;
  const etaMin = Math.max(1, Math.round((distKm / speedKmh) * 60));
  return (
    <div className="flex items-center gap-2 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl px-4 py-3">
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-blue-200">
        <Navigation size={16} className="text-white"/>
      </div>
      <div className="flex-1">
        <p className="text-[10px] text-blue-500 font-bold uppercase tracking-wider">Est. Arrival to Pickup</p>
        <p className="text-base font-black text-gray-900">{etaMin} min <span className="text-gray-400 font-semibold text-xs">({distKm < 1 ? `${Math.round(distKm * 1000)}m` : `${distKm.toFixed(1)} km`})</span></p>
        <p className="text-[10px] text-blue-400">Estimate only · {speedKmh} km/h avg</p>
      </div>
    </div>
  );
}

/**
 * Compress an image File to JPEG, scaled so its width ≤ maxWidthPx and the
 * resulting blob is ≤ maxSizeBytes. Returns a new File ready for multipart
 * upload. Throws if compression fails or the result still exceeds maxSizeBytes.
 */
async function compressImage(
  file: File,
  maxWidthPx = 1920,
  maxSizeBytes = 1.5 * 1024 * 1024,
): Promise<File> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Photo too large, please try again."));
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      if (!dataUrl) { reject(new Error("Photo too large, please try again.")); return; }
      const img = new Image();
      img.onerror = () => reject(new Error("Photo too large, please try again."));
      img.onload = () => {
        const scale = Math.min(1, maxWidthPx / img.width);
        const canvas = document.createElement("canvas");
        canvas.width  = Math.round(img.width  * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Photo too large, please try again.")); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error("Photo too large, please try again.")); return; }
          if (blob.size > maxSizeBytes) {
            reject(new Error("Photo too large, please try again."));
            return;
          }
          const baseName = (file.name || "proof").replace(/\.[^.]+$/, "");
          resolve(new File([blob], `${baseName}.jpg`, { type: "image/jpeg" }));
        }, "image/jpeg", 0.85);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export default function Active() {
  const qc = useQueryClient();
  const { config } = usePlatformConfig();
  const { user } = useAuth();
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const currency = config.platform.currencySymbol ?? "Rs.";
  const ORDER_LABELS = [T("goToStore"), T("pickedUp"), T("delivered")];
  const RIDE_LABELS = [T("acceptOrder"), T("atPickup"), T("inTransit"), T("done")];
  const [toastMsg, setToastMsg]                    = useState("");
  const [toastIsError, setToastIsError]            = useState(false);
  const [syncFailedCount, setSyncFailedCount]      = useState(0);
  const [showCancelConfirm, setShowCancelConfirm]  = useState(false);
  const [showOtpModal, setShowOtpModal]            = useState(false);
  const [otpInput, setOtpInput]                    = useState("");
  const [cancelTarget, setCancelTarget]            = useState<"order" | "ride">("order");
  const [proofPhoto, setProofPhoto]                = useState<string | null>(null);   /* preview dataURL */
  const [proofFile, setProofFile]                  = useState<File | null>(null);     /* actual File for multipart upload */
  const [proofFileName, setProofFileName]          = useState<string>("");
  const [proofUploading, setProofUploading]        = useState(false);
  const [showNoPhotoWarning, setShowNoPhotoWarning] = useState(false);
  const photoInputRef                              = useRef<HTMLInputElement>(null);
  const toastTimerRef                              = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pressedBtn, setPressedBtn]                = useState<string | null>(null);
  const [isOffline, setIsOffline]                  = useState(!navigator.onLine);
  const [riderPos, setRiderPos]                    = useState<{ lat: number; lng: number } | null>(null);
  const [adminMessages, setAdminMessages]          = useState<Array<{ text: string; ts: string; from: "admin" | "rider" }>>([]);
  const [showAdminChat, setShowAdminChat]          = useState(false);
  const [chatReply, setChatReply]                  = useState("");
  const { socket: sharedSocket, setRiderPosition, setSlowGps } = useSocket();
  const socketRef = useRef(sharedSocket);
  socketRef.current = sharedSocket;

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!sharedSocket) return;
    const handler = (msg: { message: string; sentAt: string; from: "admin" }) => {
      if (!isMountedRef.current) return;
      setAdminMessages(prev => [...prev, { text: msg.message, ts: msg.sentAt, from: "admin" }]);
      setShowAdminChat(true);
    };
    sharedSocket.on("admin:chat", handler);
    return () => { sharedSocket.off("admin:chat", handler); };
  }, [sharedSocket]);

  useEffect(() => {
    if (!sharedSocket) return;
    const onOrderUpdate = () => {
      if (!isMountedRef.current) return;
      qc.invalidateQueries({ queryKey: ["rider-active"] });
    };
    sharedSocket.on("order:update", onOrderUpdate);
    sharedSocket.on("order:assigned", onOrderUpdate);
    return () => {
      sharedSocket.off("order:update", onOrderUpdate);
      sharedSocket.off("order:assigned", onOrderUpdate);
    };
  }, [sharedSocket, qc]);

  type QueuedUpdate = { kind: "location" | "status"; run: () => Promise<unknown> };
  const pendingUpdatesRef                          = useRef<QueuedUpdate[]>([]);
  /* Replace or add queued updates — deduplicate by kind to keep only latest */
  const queueUpdate = (update: QueuedUpdate) => {
    pendingUpdatesRef.current = [
      ...pendingUpdatesRef.current.filter(u => u.kind !== update.kind),
      update,
    ];
  };

  useEffect(() => {
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, []);

  /* Stable refs to avoid stale closures in the online/offline effect */
  const refetchRef    = useRef<(() => void) | null>(null);
  const showToastRef  = useRef<((msg: string, isError?: boolean) => void) | null>(null);
  const TRef          = useRef<((key: TranslationKey) => string) | null>(null);
  const retrySyncRef  = useRef<(() => void) | null>(null);

  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => {
      setIsOffline(false);
      setSyncFailedCount(0); /* clear stale failure banner while reconnecting */
      const pending = [...pendingUpdatesRef.current];
      pendingUpdatesRef.current = [];
      const locationUpdates = pending.filter(item => item.kind === "location");
      const statusUpdates = pending.filter(item => item.kind === "status");
      if (locationUpdates.length > 0) {
        const latest = locationUpdates[locationUpdates.length - 1];
        latest.run().catch(() => { pendingUpdatesRef.current.push(latest); });
      }
      if (statusUpdates.length > 0) {
        /* Re-add to queue then drain via the shared function (also used by the
           retry banner button) so both paths share identical failure handling. */
        pendingUpdatesRef.current.push(...statusUpdates);
        retrySyncRef.current?.();
      }
      refetchRef.current?.();
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, [qc]);


  const showToast = (msg: string, isError = false) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMsg(msg); setToastIsError(isError);
    toastTimerRef.current = setTimeout(() => setToastMsg(""), 3000);
  };
  /* Keep refs in sync with latest closures */
  showToastRef.current = showToast;
  TRef.current = T;

  const [tabVisible, setTabVisible] = useState(!document.hidden);

  useEffect(() => {
    const handler = () => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  /* ── Shared status-queue drain ───────────────────────────────────────────────
     Called by both goOnline (automatic) and the retry banner button (manual).
     Extracts all pending status updates, runs them with allSettled, requeues
     failures and sets syncFailedCount so the persistent error banner appears. */
  const drainStatusQueue = () => {
    const allPending = [...pendingUpdatesRef.current];
    const statusUpdates = allPending.filter(item => item.kind === "status");
    if (statusUpdates.length === 0) return;
    /* Remove status items from queue; location updates remain for their own drain */
    pendingUpdatesRef.current = allPending.filter(item => item.kind === "location");
    setSyncFailedCount(0); /* clear previous banner count while retrying */
    Promise.allSettled(statusUpdates.map(item => item.run())).then(results => {
      results.forEach((result, i) => {
        if (result.status === "rejected") {
          console.error(`[RiderActive] Status update ${i} failed:`, result.reason);
        }
      });
      const failed = statusUpdates.filter((_, i) => results[i]?.status === "rejected");
      if (failed.length > 0) {
        pendingUpdatesRef.current.push(...failed);
        setSyncFailedCount(failed.length);
      }
      if (results.some(r => r.status === "fulfilled")) {
        qc.invalidateQueries({ queryKey: ["rider-active"] });
        qc.invalidateQueries({ queryKey: ["rider-history"] });
        qc.invalidateQueries({ queryKey: ["rider-earnings"] });
        qc.invalidateQueries({ queryKey: ["rider-requests"] });
        showToastRef.current?.(TRef.current?.("statusUpdated") ?? "Status updated");
      }
    });
  };
  /* Keep retrySyncRef pointing to the latest drainStatusQueue on every render */
  retrySyncRef.current = drainStatusQueue;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["rider-active"],
    queryFn:  () => api.getActive(),
    refetchInterval: tabVisible ? 8000 : false,
  });
  /* Keep refetchRef in sync so the offline→online handler always calls the latest refetch */
  refetchRef.current = refetch;

  useEffect(() => {
    if (tabVisible) refetch();
  }, [tabVisible]);

  const [gpsWarning, setGpsWarning] = useState<string | null>(null);
  const gpsWarningRef = useRef<string | null>(null);
  const [showProximityWarning, setShowProximityWarning] = useState(false);

  const setGpsWarningWithRef = (val: string | null) => {
    gpsWarningRef.current = val;
    setGpsWarning(val);
  };

  /* Battery-aware GPS: dynamic REST-ping interval — 5 s normal, 30 s when low battery
     or far from next waypoint. Updated inside the watchPosition callback so it
     reacts to real-time conditions without restarting the watcher. */
  const batteryRef = useRef<number | undefined>(undefined);
  const minGpsIntervalMsRef = useRef(5_000);
  /* Mirror the latest query data into a ref so the watchPosition callback can
     read the current order/ride without closing over a stale snapshot. */
  const activeDataRef = useRef(data);
  activeDataRef.current = data;

  /* Set up battery monitoring for the active delivery page */
  useEffect(() => {
    type BatteryManager = {
      level: number;
      addEventListener: (ev: string, cb: () => void) => void;
      removeEventListener: (ev: string, cb: () => void) => void;
    };
    let batt: BatteryManager | undefined;
    const onLevelChange = () => { if (batt) batteryRef.current = batt.level; };
    (navigator as unknown as { getBattery?: () => Promise<BatteryManager> }).getBattery?.()
      .then((b) => {
        batt = b;
        batteryRef.current = b.level;
        b.addEventListener("levelchange", onLevelChange);
      })
      .catch(() => {});
    return () => { batt?.removeEventListener("levelchange", onLevelChange); };
  }, []);


  useEffect(() => {
    if (data?.order && !data?.ride) setCancelTarget("order");
    else if (data?.ride && !data?.order) setCancelTarget("ride");
  }, [!!data?.order, !!data?.ride]);

  useEffect(() => {
    if (!riderPos || !data?.order) { setShowProximityWarning(false); return; }
    const vendorLat = (data.order as Record<string, unknown>).vendorLat as number | undefined;
    const vendorLng = (data.order as Record<string, unknown>).vendorLng as number | undefined;
    if (!vendorLat || !vendorLng) { setShowProximityWarning(false); return; }
    const R = 6371000;
    const dLat = (vendorLat - riderPos.lat) * Math.PI / 180;
    const dLng = (vendorLng - riderPos.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(riderPos.lat * Math.PI/180) * Math.cos(vendorLat * Math.PI/180) * Math.sin(dLng/2)**2;
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    setShowProximityWarning(dist > 500 && !data.order.status?.startsWith("picked") && data.order.status !== "out_for_delivery");
  }, [riderPos, data?.order]);

  useEffect(() => {
    const hasActiveWork = !!(data?.order || data?.ride);
    if (!hasActiveWork || !user?.id) return;
    if (!navigator?.geolocation) return;

    let lastSentTime = 0;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        /* Guard: stop all state updates if the component has already unmounted */
        if (!isMountedRef.current) return;
        setRiderPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        /* Feed the shared socket position cache — heartbeat uses this instead of its own GPS call */
        setRiderPosition(pos.coords.latitude, pos.coords.longitude);

        /* Battery-aware interval: slow down REST pings to 30 s when battery is
           below 20% OR the rider is more than 2 km from the next waypoint.
           Both conditions return to 5 s once they are no longer true. */
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const batteryLow = typeof batteryRef.current === "number" && batteryRef.current < 0.20;
        let isFar = false;
        const active = activeDataRef.current;
        if (active?.order) {
          const o = active.order as Record<string, unknown>;
          const wLat = (o.dropoffLat ?? o.pickupLat) as number | undefined;
          const wLng = (o.dropoffLng ?? o.pickupLng) as number | undefined;
          if (wLat && wLng) isFar = haversineDistance(lat, lng, wLat, wLng) > 2;
        } else if (active?.ride) {
          const r = active.ride as Record<string, unknown>;
          const wLat = (r.dropoffLat ?? r.pickupLat) as number | undefined;
          const wLng = (r.dropoffLng ?? r.pickupLng) as number | undefined;
          if (wLat && wLng) isFar = haversineDistance(lat, lng, wLat, wLng) > 2;
        }
        const slow = batteryLow || isFar;
        minGpsIntervalMsRef.current = slow ? 30_000 : 5_000;
        setSlowGps(slow);

        const now = Date.now();
        if (now - lastSentTime < minGpsIntervalMsRef.current) return;
        lastSentTime = now;
        /* Detect client-side mock GPS: accuracy === 0 is impossible with real hardware sensors.
           Suppress the ping entirely to prevent spoofed coordinates reaching the server. */
        const isMockGps = pos.coords.accuracy !== null && pos.coords.accuracy === 0;
        if (isMockGps) {
          if (isMountedRef.current) {
            setGpsWarningWithRef("Suspicious GPS accuracy detected. Please disable mock location apps.");
          }
          return;
        }
        const gpsPayload = {
          latitude:     pos.coords.latitude,
          longitude:    pos.coords.longitude,
          accuracy:     pos.coords.accuracy ?? undefined,
          speed:        pos.coords.speed ?? undefined,
          heading:      pos.coords.heading ?? undefined,
          rideId:       data?.ride?.id ?? undefined,
        };
        const queuedPing = {
          id:        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          latitude:  pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy:  pos.coords.accuracy ?? undefined,
          speed:     pos.coords.speed ?? undefined,
          heading:   pos.coords.heading ?? undefined,
        };
        const doUpdate = () => api.updateLocation(gpsPayload).then(() => {
          if (isMountedRef.current && gpsWarningRef.current) setGpsWarningWithRef(null);
        }).catch((err: unknown) => {
          if (!isMountedRef.current) return;
          const msg = err instanceof Error ? err.message : "";
          const isSpoofError = msg.toLowerCase().includes("spoof") || msg.toLowerCase().includes("mock");
          if (isSpoofError) {
            setGpsWarningWithRef("Mock location detected — please disable fake GPS apps.");
          } else {
            /* Enqueue for batch replay even when browser reports "online" —
               fetch may fail due to transient network issues or proxy hiccups */
            enqueue(queuedPing).catch(() => {});
            setGpsWarningWithRef(TRef.current?.("gpsLocationError") ?? "Location not being tracked — check GPS permissions");
          }
        });
        if (!navigator.onLine) {
          /* Persist to IndexedDB for later batch replay on reconnect */
          enqueue(queuedPing).catch(() => {});
          queueUpdate({ kind: "location", run: doUpdate });
        } else {
          doUpdate();
        }
      },
      () => {
        if (!isMountedRef.current) return;
        setGpsWarningWithRef(TRef.current?.("gpsNotAvailable") ?? "GPS not available — please enable location in Settings");
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [!!data?.order, !!data?.ride, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const unregister = registerDrainHandler(async (pings: QueuedPing[]) => {
      await api.batchLocation(pings.map(p => ({
        timestamp: p.timestamp,
        latitude: p.latitude,
        longitude: p.longitude,
        accuracy: p.accuracy,
        speed: p.speed,
        heading: p.heading,
        batteryLevel: p.batteryLevel,
        mockProvider: p.mockProvider,
        action: p.action,
      })));
    });
    return unregister;
  }, [user?.id]);

  const handlePhotoCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProofFileName(file.name);

    /* Compress to ≤ 1.5 MB / max 1920 px wide for the actual upload file */
    let compressed: File;
    try {
      compressed = await compressImage(file, 1920, 1.5 * 1024 * 1024);
    } catch {
      showToast("Photo too large, please try again.", true);
      setProofFileName("");
      setProofFile(null);
      setProofPhoto(null);
      if (e.target) e.target.value = "";
      return;
    }
    setProofFile(compressed);

    /* Compress for preview dataURL (display only — lower quality thumbnail) */
    const compressForPreview = (dataUrl: string): Promise<string> =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 1280 / img.width);
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext("2d");
          if (!ctx) { resolve(dataUrl); return; }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.7));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      });

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const raw = ev.target?.result as string;
      if (!raw) return;
      const preview = await compressForPreview(raw);
      setProofPhoto(preview);
    };
    reader.onerror = () => { setProofFileName(""); setProofFile(null); };
    reader.readAsDataURL(file);
  };

  const handleMarkDelivered = async (id: string, forceNoPhoto = false) => {
    if (!proofPhoto && !forceNoPhoto) {
      setShowNoPhotoWarning(true);
      return;
    }
    setShowNoPhotoWarning(false);
    if (proofPhoto && !navigator.onLine) {
      showToast("Cannot upload photo while offline — please reconnect and try again.", true);
      return;
    }
    let photoUrl: string | undefined;
    if (proofFile) {
      /* Use multipart/form-data upload to avoid large base64 JSON payload */
      setProofUploading(true);
      try {
        const uploadRes = await api.uploadProof(proofFile);
        if (typeof uploadRes?.url !== "string" || !uploadRes.url.trim()) {
          throw new Error("Photo upload succeeded but server returned no URL — please retake");
        }
        photoUrl = uploadRes.url;
      } catch (e: unknown) {
        const status = (e as { status?: number })?.status;
        if (status === 400 || status === 413) {
          showToast("Photo too large, please try again.", true);
        } else {
          showToast(e instanceof Error ? e.message : "Photo upload failed. Please try again.", true);
        }
        setProofUploading(false);
        return;
      }
      setProofUploading(false);
    }
    if (!navigator.onLine) {
      showToast("You're offline — update queued for retry", true);
      enqueueAction("update_order", id, { status: "delivered", ...(photoUrl ? { proofPhoto: photoUrl } : {}) }).catch(() => {});
      return;
    }
    updateOrderMut.mutate({ id, status: "delivered", photoUrl });
  };

  /* O3 / O4 / O5: Order/Ride status mutations.
     - O3: Offline-queue side effects (toast, IDB enqueue) live in `onMutate`,
       not in the mutationFn. React Query may retry a failing mutation; mixing
       `showToast` + `queueUpdate` into the mutationFn used to double-fire
       both on retry. The mutationFn is now a pure async wrapper around the
       network call.
     - O4: `onError` maps known backend codes to translated strings via
       `mapMutationError(e, T)`; falls back to a generic translated message
       so Urdu/RU users never see English server text.
     - O5: We treat `navigator.onLine` as a hint only — every fetch failure
       falls through to the offline queue regardless of the flag. iOS captive
       portals report `true` while behind a paywall; the previous code would
       try to send and hang for the 30 s API timeout. The `onMutate` queueing
       is the optimistic path; `onError` handles the fallback. */
  const mapMutationError = (e: Error, t: typeof T): string => {
    /* O4: Map known backend categories onto a single translated fallback.
       Only `somethingWentWrong` is guaranteed to exist in every locale, so we
       use it for the catch-all and leave per-category English hints for the
       narrower paths. The hint text is intentionally short, since the toast
       shows on top of an already-translated UI. */
    const raw = (e?.message ?? "").toString();
    const lower = raw.toLowerCase();
    if (lower.includes("offline") || lower.includes("network")) return "Network unavailable — will retry when online";
    if (lower.includes("timeout")) return "Request timed out — please try again";
    if (lower.includes("not found") || lower.includes("404")) return t("somethingWentWrong") as string;
    if (lower.includes("forbidden") || lower.includes("403")) return t("somethingWentWrong") as string;
    return t("somethingWentWrong") as string;
  };

  const updateOrderMut = useMutation({
    mutationFn: ({ id, status, photoUrl }: { id: string; status: string; photoUrl?: string }) =>
      api.updateOrder(id, status, photoUrl),
    onMutate: (vars) => {
      /* O5: Queue speculatively when the OS reports offline; the network
         call still runs (in case the flag is wrong) and `onError` will
         re-queue if it actually fails. */
      if (!navigator.onLine) {
        showToast("You're offline — update queued for retry", true);
        enqueueAction("update_order", vars.id, { status: vars.status, ...(vars.photoUrl ? { proofPhoto: vars.photoUrl } : {}) }).catch(() => {});
        return { enqueued: true };
      }
      return { enqueued: false };
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["rider-active"] });
      qc.invalidateQueries({ queryKey: ["rider-history"] });
      qc.invalidateQueries({ queryKey: ["rider-earnings"] });
      qc.invalidateQueries({ queryKey: ["rider-requests"] });
      if (vars.status === "delivered") {
        setProofPhoto(null);
        setProofFileName("");
        setProofFile(null);
        if (photoInputRef.current) photoInputRef.current.value = "";
        showToast(T("orderDeliveredEarnings"));
      } else if (vars.status === "cancelled") {
        setProofPhoto(null);
        setProofFile(null);
        setProofFileName("");
        showToast(T("orderCancelledMsg"));
      } else {
        showToast(T("statusUpdated"));
      }
    },
    onError: (e: Error, vars, context) => {
      /* O5: If the request failed because the network truly was down, queue
         it for retry. We rely on the failure rather than `navigator.onLine`. */
      const looksLikeNetworkErr = /network|fetch|timeout|offline/i.test(e?.message || "");
      if (looksLikeNetworkErr && !context?.enqueued) {
        enqueueAction("update_order", vars.id, { status: vars.status, ...(vars.photoUrl ? { proofPhoto: vars.photoUrl } : {}) }).catch(() => {});
      }
      /* O4: Translated message only — never raw server English. */
      showToast(mapMutationError(e, T), true);
    },
    onSettled: () => {
      /* O6: Always close the cancel-confirm modal once the mutation resolves
         (success or failure). Previously the modal stayed open on error,
         leaving a disabled button and no path forward without re-tap. */
      setShowCancelConfirm(false);
    },
  });

  const updateRideMut = useMutation({
    mutationFn: ({ id, status, lat, lng }: { id: string; status: string; lat?: number; lng?: number }) => {
      const loc = lat != null && lng != null ? { lat, lng } : undefined;
      return api.updateRide(id, status, loc);
    },
    onMutate: (vars) => {
      if (!navigator.onLine) {
        showToast("You're offline — update queued for retry", true);
        const loc = vars.lat != null && vars.lng != null ? { lat: vars.lat, lng: vars.lng } : undefined;
        enqueueAction("update_ride", vars.id, { status: vars.status, ...(loc ?? {}) }).catch(() => {});
        return { enqueued: true };
      }
      return { enqueued: false };
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["rider-active"] });
      qc.invalidateQueries({ queryKey: ["rider-history"] });
      qc.invalidateQueries({ queryKey: ["rider-earnings"] });
      qc.invalidateQueries({ queryKey: ["rider-requests"] });
      logRideEvent(vars.id, vars.status, (msg, isErr) => showToast(msg, isErr));
      if (vars.status === "completed") showToast(T("rideCompletedEarnings"));
      else if (vars.status === "cancelled") showToast(T("rideCancelledMsg"));
      else showToast(T("statusUpdated"));
    },
    onError: (e: Error, vars, context) => {
      const looksLikeNetworkErr = /network|fetch|timeout|offline/i.test(e?.message || "");
      if (looksLikeNetworkErr && !context?.enqueued) {
        const loc = vars.lat != null && vars.lng != null ? { lat: vars.lat, lng: vars.lng } : undefined;
        enqueueAction("update_ride", vars.id, { status: vars.status, ...(loc ?? {}) }).catch(() => {});
      }
      showToast(mapMutationError(e, T), true);
    },
    onSettled: () => {
      setShowCancelConfirm(false);
    },
  });

  const verifyOtpMut = useMutation({
    mutationFn: ({ id, otp }: { id: string; otp: string }) => api.verifyRideOtp(id, otp),
    onSuccess: () => {
      setShowOtpModal(false);
      setOtpInput("");
      qc.invalidateQueries({ queryKey: ["rider-active"] });
      showToast("OTP verified! You can now start the ride.");
    },
    onError: (e: Error) => showToast(e.message, true),
  });

  if (isLoading) return <SkeletonActive />;

  const order = data?.order;
  const ride  = data?.ride;

  if (!order && !ride) return (
    <div className="min-h-screen bg-[#F5F6F8] flex flex-col">
      <div className="bg-gradient-to-br from-gray-900 via-gray-900 to-gray-800 px-5 pb-10 rounded-b-[2rem] relative overflow-hidden"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 3.5rem)" }}>
        <div className="absolute -top-20 -right-20 w-72 h-72 rounded-full bg-green-500/[0.04]"/>
        <div className="absolute bottom-10 -left-16 w-56 h-56 rounded-full bg-white/[0.02]"/>
        <div className="relative">
          <h1 className="text-2xl font-extrabold text-white tracking-tight">{T("activeTask")}</h1>
          <p className="text-white/40 text-sm mt-0.5">{T("noCurrentAssignment")}</p>
        </div>
      </div>
      {syncFailedCount > 0 && !isOffline && (
        <div className="mx-4 mt-4 bg-gradient-to-r from-red-50 to-orange-50 border border-red-300 rounded-3xl p-3.5 flex items-center gap-3 shadow-sm">
          <div className="w-9 h-9 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={18} className="text-red-600"/>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-extrabold text-red-800 leading-snug">
              {syncFailedCount} status update{syncFailedCount > 1 ? "s" : ""} could not be synced — tap to retry manually.
            </p>
          </div>
          <button
            onClick={() => retrySyncRef.current?.()}
            className="flex items-center gap-1.5 px-3 py-2 bg-red-600 text-white text-xs font-bold rounded-2xl flex-shrink-0 active:scale-95 transition-transform shadow-md shadow-red-200"
          >
            <RefreshCw size={13}/>
            Retry
          </button>
        </div>
      )}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center">
          <div className="w-28 h-28 bg-gradient-to-br from-gray-50 to-gray-100 rounded-[2rem] flex items-center justify-center mx-auto mb-6 shadow-inner border border-gray-200/50">
            <Bike size={52} className="text-gray-300"/>
          </div>
          <h2 className="text-xl font-extrabold text-gray-700">{T("noActiveTask")}</h2>
          <p className="text-gray-400 mt-2 text-sm max-w-[260px] mx-auto leading-relaxed">{T("acceptFromHome")}</p>
          <button onClick={() => refetch()}
            className="mt-6 bg-gray-900 text-white px-7 py-3.5 rounded-xl text-sm font-bold flex items-center gap-2 mx-auto active:scale-[0.97] transition-transform shadow-sm">
            <RefreshCw size={15}/> {T("refresh")}
          </button>
        </div>
      </div>
    </div>
  );

  const orderStep = !order ? 0
    : order.status === "delivered" ? 2
    : (order.status === "picked_up" || order.status === "out_for_delivery") ? 1
    : 0;
  const rideStep  = ride ? Math.max(0, RIDE_STEPS.indexOf(ride.status)) : 0;
  const startedAt = order?.acceptedAt || ride?.acceptedAt || null;

  function OrderTypeIcon({ type }: { type: string }) {
    if (type === "food") return <UtensilsCrossed size={22} className="text-white"/>;
    if (type === "mart") return <ShoppingCart size={22} className="text-white"/>;
    return <Package size={22} className="text-white"/>;
  }

  const orderTypeGradient = (type: string) => {
    if (type === "food") return "from-orange-500 via-red-500 to-pink-600";
    if (type === "mart") return "from-blue-500 via-indigo-500 to-violet-600";
    return "from-teal-500 via-cyan-500 to-blue-600";
  };

  return (
    <div className="min-h-screen bg-[#F5F6F8]">
      <div className="bg-gradient-to-br from-gray-900 via-gray-900 to-gray-800 px-5 pb-7 rounded-b-[2rem] relative overflow-hidden"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 3.5rem)" }}>
        <div className="absolute -top-20 -right-20 w-72 h-72 rounded-full bg-green-500/[0.04]"/>
        <div className="absolute bottom-10 -left-16 w-56 h-56 rounded-full bg-white/[0.02]"/>
        <div className="absolute top-1/2 left-1/2 w-32 h-32 rounded-full bg-white/[0.015] -translate-x-1/2 -translate-y-1/2"/>
        <div className="relative flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-2.5 h-2.5 bg-green-400 rounded-full animate-pulse shadow-sm shadow-green-400"/>
              <span className="text-white/40 text-[10px] font-bold uppercase tracking-widest">Live</span>
            </div>
            <h1 className="text-2xl font-black text-white tracking-tight">{order ? T("activeDelivery") : T("activeRide")}</h1>
            <p className="text-white/40 text-sm mt-1 font-medium">
              {order ? `${order.type} order — ${(order.status === "picked_up" || order.status === "out_for_delivery") ? "Delivering to customer" : "Pick up from store"}` : `${ride?.type} ride in progress`}
            </p>
          </div>
          <ElapsedBadge startIso={startedAt}/>
        </div>
      </div>

      {isOffline && (
        <div className="mx-4 mt-3 bg-gradient-to-r from-red-50 to-orange-50 border border-red-300 rounded-3xl p-3.5 flex items-center gap-3 shadow-sm">
          <div className="w-9 h-9 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0 animate-pulse">
            <WifiOff size={18} className="text-red-600"/>
          </div>
          <div className="flex-1">
            <p className="text-xs font-extrabold text-red-800">You're offline{pendingUpdatesRef.current.length > 0 ? ` — ${pendingUpdatesRef.current.length} update${pendingUpdatesRef.current.length > 1 ? "s" : ""} queued` : ""}</p>
            <p className="text-[11px] text-red-600 mt-0.5 leading-relaxed">Updates will retry automatically when reconnected.</p>
          </div>
        </div>
      )}

      {syncFailedCount > 0 && !isOffline && (
        <div className="mx-4 mt-3 bg-gradient-to-r from-red-50 to-orange-50 border border-red-300 rounded-3xl p-3.5 flex items-center gap-3 shadow-sm">
          <div className="w-9 h-9 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={18} className="text-red-600"/>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-extrabold text-red-800 leading-snug">
              {syncFailedCount} status update{syncFailedCount > 1 ? "s" : ""} could not be synced — tap to retry manually.
            </p>
          </div>
          <button
            onClick={() => retrySyncRef.current?.()}
            className="flex items-center gap-1.5 px-3 py-2 bg-red-600 text-white text-xs font-bold rounded-2xl flex-shrink-0 active:scale-95 transition-transform shadow-md shadow-red-200"
          >
            <RefreshCw size={13}/>
            Retry
          </button>
        </div>
      )}

      {gpsWarning && (
        <div className="mx-4 mt-3 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-3xl p-3.5 flex items-start gap-3 shadow-sm animate-[slideDown_0.3s_ease-out]">
          <div className="w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={18} className="text-amber-600"/>
          </div>
          <div className="flex-1">
            <p className="text-xs font-extrabold text-amber-800">GPS Warning</p>
            <p className="text-[11px] text-amber-700 mt-0.5 leading-relaxed">{gpsWarning}</p>
          </div>
          <button onClick={() => setGpsWarning(null)} className="w-7 h-7 rounded-lg bg-amber-100 flex items-center justify-center text-amber-500 active:bg-amber-200 transition-colors">
            <X size={13}/>
          </button>
        </div>
      )}

      {showProximityWarning && (
        <div className="mx-4 mt-3 bg-gradient-to-r from-yellow-50 to-amber-50 border border-yellow-300 rounded-3xl p-3.5 flex items-center gap-3 shadow-sm animate-[slideDown_0.3s_ease-out]">
          <div className="w-9 h-9 rounded-xl bg-yellow-100 flex items-center justify-center flex-shrink-0">
            <MapPin size={18} className="text-yellow-600"/>
          </div>
          <div className="flex-1">
            <p className="text-xs font-extrabold text-yellow-800">Far from store</p>
            <p className="text-[11px] text-yellow-700 mt-0.5 leading-relaxed">You're more than 500m from the store. Head there to pick up the order.</p>
          </div>
        </div>
      )}

      {/* Admin chat banner — shown when admin has sent a message */}
      {adminMessages.length > 0 && (
        <div className="mx-4 mt-3 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-3xl p-3.5 flex items-start gap-3 shadow-lg shadow-blue-200 animate-[slideDown_0.3s_ease-out]">
          <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
            <MessageSquare size={16} className="text-white"/>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-extrabold text-white">Message from Admin</p>
            <p className="text-[11px] text-blue-100 mt-0.5 leading-relaxed truncate">{adminMessages[adminMessages.length - 1]?.text}</p>
          </div>
          <button onClick={() => setShowAdminChat(true)} className="text-xs font-bold bg-white text-blue-600 px-2.5 py-1 rounded-lg flex-shrink-0">
            View
          </button>
          <button onClick={() => setAdminMessages([])} className="text-xs text-white/60 hover:text-white flex-shrink-0">
            <X size={14}/>
          </button>
        </div>
      )}

      {/* Admin chat modal */}
      {showAdminChat && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowAdminChat(false)}>
          <div className="bg-white w-full max-w-md rounded-t-3xl shadow-2xl p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="font-black text-gray-900 flex items-center gap-2"><MessageSquare size={16} className="text-blue-600"/> Admin Chat</p>
                <p className="text-xs text-gray-400">Admin can see your messages</p>
              </div>
              <button onClick={() => setShowAdminChat(false)}><X size={18} className="text-gray-400"/></button>
            </div>
            <div className="bg-gray-50 rounded-2xl p-3 min-h-[80px] max-h-44 overflow-y-auto space-y-2 mb-3">
              {adminMessages.map((m) => (
                <div key={`${m.ts}-${m.text}`} className={`flex ${m.from === "rider" ? "justify-end" : "justify-start"}`}>
                  <div className={`text-xs px-3 py-1.5 rounded-xl max-w-[80%] ${m.from === "rider" ? "bg-gray-900 text-white" : "bg-blue-600 text-white"}`}>{m.text}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={chatReply}
                onChange={e => setChatReply(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && chatReply.trim() && socketRef.current) {
                    const msg = chatReply.trim();
                    socketRef.current.emit("rider:chat", { message: msg });
                    setAdminMessages(prev => [...prev, { text: msg, ts: new Date().toISOString(), from: "rider" }]);
                    setChatReply("");
                  }
                }}
                placeholder="Reply to admin..."
                className="flex-1 text-sm border rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-blue-400"
              />
              <button
                onClick={() => {
                  if (!chatReply.trim() || !socketRef.current) return;
                  const msg = chatReply.trim();
                  socketRef.current.emit("rider:chat", { message: msg });
                  setAdminMessages(prev => [...prev, { text: msg, ts: new Date().toISOString(), from: "rider" }]);
                  setChatReply("");
                }}
                className="bg-blue-600 text-white text-sm font-bold px-4 py-2 rounded-xl"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="px-4 py-4 space-y-4">

        {order && (
          <>
            <div className="bg-white rounded-3xl shadow-lg shadow-gray-200/50 border border-gray-100 overflow-hidden animate-[slideUp_0.4s_ease-out]">
              <div className={`bg-gradient-to-r ${orderTypeGradient(order.type)} px-4 py-4 flex items-center gap-3 relative overflow-hidden`}>
                <div className="absolute -top-6 -right-6 w-24 h-24 bg-white/10 rounded-full"/>
                <div className="absolute -bottom-4 -left-4 w-16 h-16 bg-white/5 rounded-full"/>
                <div className="relative w-12 h-12 bg-white/20 backdrop-blur-md rounded-2xl flex items-center justify-center flex-shrink-0 border border-white/20 shadow-inner">
                  <OrderTypeIcon type={order.type}/>
                </div>
                <div className="relative flex-1 min-w-0">
                  <p className="font-black text-white capitalize text-lg">{order.type} Order</p>
                  <p className="text-white/70 text-xs font-mono mt-0.5">#{order.id.slice(-6).toUpperCase()}</p>
                </div>
                <div className="relative text-right">
                  <p className="font-black text-white text-xl tracking-tight">{formatCurrency(order.total, currency)}</p>
                  <div className="mt-1 bg-white/15 backdrop-blur-sm rounded-lg px-2.5 py-1 border border-white/10">
                    <p className="text-white text-[10px] font-bold">You earn {formatCurrency((() => {
                      const df = config.deliveryFee;
                      let fee: number;
                      if (typeof df === "number") { fee = df; }
                      else if (df && typeof df === "object") {
                        const raw = (df as Record<string, unknown>)[order.type] ?? (df as Record<string, unknown>).mart ?? 0;
                        fee = typeof raw === "number" ? raw : parseFloat(String(raw)) || 0;
                      } else { fee = parseFloat(String(df)) || 0; }
                      const riderPct = (config.rides?.riderEarningPct ?? config.finance?.riderEarningPct) ?? 0;
                      return fee * (riderPct / 100);
                    })(), currency)}</p>
                  </div>
                </div>
              </div>

              <div className="px-5 pt-5 pb-4">
                <div className="flex items-center justify-between relative">
                  {ORDER_LABELS.map((label, i) => (
                    <div key={i} className="flex flex-col items-center gap-2 z-10" style={{ flex: 1 }}>
                      <div className={`w-11 h-11 rounded-2xl border-2 flex items-center justify-center transition-all duration-500
                        ${i < orderStep ? "bg-green-500 border-green-500 text-white shadow-lg shadow-green-200" :
                          i === orderStep ? "bg-gray-900 border-gray-900 text-white shadow-lg shadow-gray-300 ring-4 ring-gray-200" :
                          "bg-white border-gray-200 text-gray-300"}`}>
                        {i < orderStep ? <CheckCircle size={16}/> : ORDER_STEP_ICONS[i]}
                      </div>
                      <p className={`text-[10px] font-bold text-center leading-tight max-w-[70px] ${
                        i <= orderStep ? "text-gray-900" : "text-gray-400"}`}>{label}</p>
                    </div>
                  ))}
                </div>
                <div className="relative mx-10 h-1 bg-gray-100 rounded-full -mt-8 mb-6">
                  <div className="absolute top-0 left-0 h-full bg-gray-900 rounded-full transition-all duration-700 ease-out"
                    style={{ width: `${orderStep === 0 ? 0 : orderStep === 1 ? 50 : 100}%` }} />
                </div>
              </div>
            </div>

            {order && order.status !== "picked_up" && order.status !== "out_for_delivery" && order.status !== "delivered" && (
              <div className="bg-white rounded-3xl shadow-lg shadow-gray-200/50 border border-gray-100 overflow-hidden animate-[slideUp_0.5s_ease-out]">
                <div className="bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-3 flex items-center gap-2">
                  <div className="w-7 h-7 bg-white/20 backdrop-blur-sm rounded-lg flex items-center justify-center">
                    <ShoppingCart size={14} className="text-white"/>
                  </div>
                  <p className="text-sm font-black text-white uppercase tracking-wide">Step 1 — Go to Store</p>
                </div>
                <div className="p-4 space-y-3">
                  <div className="bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-100 rounded-2xl p-4">
                    <div className="flex items-start gap-3">
                      <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center flex-shrink-0 shadow-md shadow-orange-200">
                        <ShoppingCart size={18} className="text-white"/>
                      </div>
                      <div className="flex-1">
                        <p className="text-[10px] text-orange-500 font-bold uppercase tracking-wider">Vendor / Store</p>
                        <p className="text-base font-black text-gray-900 mt-0.5">{order.vendorStoreName || "Store"}</p>
                        {order.vendorPhone && (
                          <p className="text-xs text-gray-500 mt-1 flex items-center gap-1"><Phone size={10}/> {order.vendorPhone}</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {order.items && Array.isArray(order.items) && order.items.length > 0 && (
                    <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100">
                      <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-3 flex items-center gap-1.5">
                        <Package size={11}/> Items to Collect ({order.items.length})
                      </p>
                      <div className="space-y-2">
                        {(order.items as OrderItem[]).slice(0, 5).map((item: OrderItem, i: number) => (
                          <div key={i} className="flex justify-between text-sm bg-white rounded-xl px-3 py-2.5 border border-gray-100">
                            <span className="text-gray-700 font-medium">{item.name} <span className="text-gray-400">×{item.quantity}</span></span>
                            <span className="font-bold text-gray-800">{formatCurrency(item.price * item.quantity, currency)}</span>
                          </div>
                        ))}
                        {order.items.length > 5 && (
                          <p className="text-xs text-gray-400 text-center mt-1 font-medium">+{order.items.length - 5} {T("moreItems")}</p>
                        )}
                      </div>
                    </div>
                  )}

                  {order.vendorAddress && (
                    <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 rounded-2xl p-4">
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-blue-200">
                          <MapPin size={18} className="text-white"/>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[10px] text-blue-500 font-bold uppercase tracking-wider">Store Location</p>
                          <p className="text-sm font-bold text-gray-900 mt-0.5 break-words">{order.vendorAddress}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <NavButton label={T("goToStore")} lat={order.vendorLat} lng={order.vendorLng} address={order.vendorAddress || order.vendorStoreName} color="orange" />
                    {order.vendorPhone && <CallButton phone={order.vendorPhone} label="Call Store" name={order.vendorStoreName} />}
                  </div>

                  {riderPos && order.vendorLat != null && order.vendorLng != null && (
                    <MapErrorBoundary>
                      <TurnByTurnPanel
                        fromLat={riderPos.lat} fromLng={riderPos.lng}
                        toLat={order.vendorLat} toLng={order.vendorLng}
                        label="Store"
                        riderLat={riderPos.lat} riderLng={riderPos.lng}
                      />
                    </MapErrorBoundary>
                  )}

                  {/* ── Route map: rider → store ── */}
                  {order.vendorLat != null && order.vendorLng != null && riderPos && (
                    <MapErrorBoundary fallbackMsg="Route map unavailable">
                      <RideRouteMap
                        pickupLat={riderPos.lat} pickupLng={riderPos.lng} pickupLabel="Your Position"
                        dropLat={order.vendorLat} dropLng={order.vendorLng} dropLabel={order.vendorAddress || order.vendorStoreName}
                        riderLat={riderPos.lat} riderLng={riderPos.lng}
                      />
                    </MapErrorBoundary>
                  )}

                  <button
                    onClick={() => { updateOrderMut.mutate({ id: order.id, status: "picked_up" }); }}
                    disabled={updateOrderMut.isPending}
                    onTouchStart={() => setPressedBtn("pickup")} onTouchEnd={() => setPressedBtn(null)}
                    className={`w-full bg-gray-900 text-white font-black rounded-2xl py-4 text-base disabled:opacity-60 flex items-center justify-center gap-2.5 shadow-lg transition-transform ${pressedBtn === "pickup" ? "scale-[0.97]" : ""}`}>
                    <div className="w-8 h-8 bg-white/20 rounded-xl flex items-center justify-center">
                      <Package size={18}/>
                    </div>
                    {T("pickUpOrder")}
                    <ChevronRight size={16} className="ml-1"/>
                  </button>

                  <button
                    onClick={() => { setCancelTarget("order"); setShowCancelConfirm(true); }}
                    className="w-full border-2 border-red-200 text-red-500 text-sm font-bold rounded-xl py-3 bg-red-50/50 flex items-center justify-center gap-1.5 active:bg-red-100 transition-colors">
                    <X size={14}/> {T("cantPickUp")}
                  </button>
                </div>
              </div>
            )}

            {order && (order.status === "picked_up" || order.status === "out_for_delivery") && (
              <div className="bg-white rounded-3xl shadow-lg shadow-gray-200/50 border border-gray-100 overflow-hidden animate-[slideUp_0.5s_ease-out]">
                <div className="bg-gradient-to-r from-green-500 to-emerald-600 px-4 py-3 flex items-center gap-2">
                  <div className="w-7 h-7 bg-white/20 backdrop-blur-sm rounded-lg flex items-center justify-center">
                    <Truck size={14} className="text-white"/>
                  </div>
                  <p className="text-sm font-black text-white uppercase tracking-wide">Step 2 — Deliver</p>
                </div>
                <div className="p-4 space-y-3">
                  {order.customerName && (
                    <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 rounded-2xl px-4 py-3.5 flex items-center gap-3">
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-blue-200">
                        <User size={22} className="text-white"/>
                      </div>
                      <div>
                        <p className="text-[10px] text-blue-500 font-bold uppercase tracking-wider">Customer</p>
                        <p className="text-base font-black text-gray-900">{order.customerName}</p>
                        {order.customerPhone && <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1"><Phone size={10}/> {order.customerPhone}</p>}
                      </div>
                    </div>
                  )}

                  <div className="bg-gradient-to-br from-red-50 to-pink-50 border border-red-100 rounded-2xl p-4">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-pink-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-red-200">
                        <MapPinned size={18} className="text-white"/>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] text-red-500 font-bold uppercase tracking-wider">Delivery Address</p>
                        <p className="text-sm font-bold text-gray-900 mt-0.5 break-words">{order.deliveryAddress || "Address not provided"}</p>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <NavButton label={T("navigateLabel")} lat={order.deliveryLat} lng={order.deliveryLng} address={order.deliveryAddress} color="blue" />
                    <CallButton name={order.customerName} phone={order.customerPhone} />
                    <ChatButton name={order.customerName} />
                  </div>

                  {riderPos && order.deliveryLat != null && order.deliveryLng != null && (
                    <MapErrorBoundary>
                      <TurnByTurnPanel
                        fromLat={riderPos.lat} fromLng={riderPos.lng}
                        toLat={order.deliveryLat} toLng={order.deliveryLng}
                        label="Customer"
                        riderLat={riderPos.lat} riderLng={riderPos.lng}
                      />
                    </MapErrorBoundary>
                  )}

                  {/* ── Route map: rider → delivery ── */}
                  {order.deliveryLat != null && order.deliveryLng != null && riderPos && (
                    <MapErrorBoundary fallbackMsg="Route map unavailable">
                      <RideRouteMap
                        pickupLat={riderPos.lat} pickupLng={riderPos.lng} pickupLabel="Your Position"
                        dropLat={order.deliveryLat} dropLng={order.deliveryLng} dropLabel={order.deliveryAddress}
                        riderLat={riderPos.lat} riderLng={riderPos.lng}
                      />
                    </MapErrorBoundary>
                  )}

                  <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-4">
                    <p className="text-xs font-extrabold text-blue-700 mb-3 flex items-center gap-2">
                      <div className="w-6 h-6 bg-blue-100 rounded-lg flex items-center justify-center">
                        <Camera className="w-3.5 h-3.5 text-blue-600" />
                      </div>
                      {T("proofOfDelivery")} ({T("recommended")})
                    </p>
                    {proofPhoto ? (
                      <div className="space-y-2.5">
                        <div className="relative rounded-2xl overflow-hidden h-44 bg-gray-100 shadow-inner">
                          <SafeImage src={proofPhoto} alt="Delivery proof" className="w-full h-full object-cover" loading="eager" />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent"/>
                          <div className="absolute top-3 right-3">
                            <span className="bg-green-500 text-white text-[10px] font-bold px-3 py-1 rounded-full flex items-center gap-1 shadow-lg">
                              <CheckCircle size={10}/> {T("photoReady")}
                            </span>
                          </div>
                        </div>
                        <button onClick={() => { setProofPhoto(null); setProofFileName(""); setProofFile(null); setShowNoPhotoWarning(false); if (photoInputRef.current) photoInputRef.current.value = ""; }}
                          className="w-full text-xs text-blue-600 font-bold py-2.5 border-2 border-blue-200 rounded-xl bg-white flex items-center justify-center gap-1.5 active:bg-blue-50 transition-colors">
                          <Camera size={12}/> {T("retakePhoto")}
                        </button>
                      </div>
                    ) : (
                      <div>
                        <input
                          ref={photoInputRef}
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="hidden"
                          onChange={handlePhotoCapture}
                        />
                        <button
                          onClick={() => photoInputRef.current?.click()}
                          className="w-full border-2 border-dashed border-blue-300 rounded-2xl py-5 flex flex-col items-center gap-2.5 bg-white text-blue-500 hover:bg-blue-50 transition-all active:scale-[0.98]">
                          <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center">
                            <Camera className="w-6 h-6 text-blue-500" />
                          </div>
                          <span className="text-sm font-bold">{T("takePhoto")}</span>
                          <span className="text-[10px] text-blue-400">{T("opensCamera")}</span>
                        </button>
                      </div>
                    )}
                  </div>


                  <button
                    onClick={() => handleMarkDelivered(order.id)}
                    disabled={updateOrderMut.isPending || proofUploading}
                    onTouchStart={() => setPressedBtn("deliver")} onTouchEnd={() => setPressedBtn(null)}
                    className={`w-full font-black rounded-2xl py-4 text-lg disabled:opacity-60 transition-transform bg-gradient-to-r from-green-500 to-emerald-600 text-white flex items-center justify-center gap-2.5 shadow-lg shadow-green-200 ${pressedBtn === "deliver" ? "scale-[0.97]" : ""}`}>
                    <div className="w-8 h-8 bg-white/20 rounded-xl flex items-center justify-center">
                      {proofUploading ? <RefreshCw size={18} className="animate-spin"/> : <CheckCircle size={20}/>}
                    </div>
                    {proofUploading ? T("uploadingPhoto") : updateOrderMut.isPending ? T("updating") : proofPhoto ? T("confirmDeliveryWithProof") : T("markDelivered")}
                  </button>

                  <div>
                    <div className="w-full border-2 border-gray-100 text-gray-400 text-sm font-bold rounded-xl py-3 bg-gray-50 flex items-center justify-center gap-1.5 cursor-not-allowed">
                      <ChevronRight size={14} className="rotate-180"/> {T("backToStoreStep")}
                    </div>
                    <p className="text-[10px] text-gray-400 text-center mt-1">
                      Cannot go back — server already recorded pickup. Contact support if needed.
                    </p>
                  </div>

                  <button
                    onClick={() => { setCancelTarget("order"); setShowCancelConfirm(true); }}
                    disabled={updateOrderMut.isPending}
                    className="w-full border-2 border-red-200 text-red-500 text-sm font-bold rounded-xl py-3 bg-red-50/50 flex items-center justify-center gap-1.5 active:bg-red-100 transition-colors disabled:opacity-60">
                    <X size={14}/> {T("cannotDeliverCancel")}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {ride && (
          <div className="bg-white rounded-3xl shadow-lg shadow-gray-200/50 border border-gray-100 overflow-hidden animate-[slideUp_0.4s_ease-out]">
            <div className="bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-700 px-4 py-4 flex items-center gap-3 relative overflow-hidden">
              <div className="absolute -top-6 -right-6 w-24 h-24 bg-white/10 rounded-full"/>
              <div className="absolute -bottom-4 -left-4 w-16 h-16 bg-white/5 rounded-full"/>
              <div className="relative w-12 h-12 bg-white/20 backdrop-blur-md rounded-2xl flex items-center justify-center flex-shrink-0 border border-white/20 shadow-inner">
                {ride.type === "bike" ? <Bike size={22} className="text-white"/> : <Car size={22} className="text-white"/>}
              </div>
              <div className="relative flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-black text-white capitalize text-lg">{ride.type} Ride</p>
                  {(ride as { isPoolRide?: boolean }).isPoolRide && (
                    <span className="bg-white/20 border border-white/30 text-white text-[9px] font-bold px-2 py-0.5 rounded-full tracking-wide flex items-center gap-1">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                      POOL
                    </span>
                  )}
                </div>
                <p className="text-purple-200 text-xs font-mono mt-0.5">#{ride.id.slice(-6).toUpperCase()} · {ride.distance}km</p>
              </div>
              <div className="relative text-right">
                <p className="font-black text-white text-xl tracking-tight">{formatCurrency(ride.fare, currency)}</p>
                <div className="mt-1 bg-white/15 backdrop-blur-sm rounded-lg px-2.5 py-1 border border-white/10">
                  <p className="text-white text-[10px] font-bold">You earn {formatCurrency(ride.fare * ((config.rides?.riderEarningPct ?? config.finance.riderEarningPct) / 100), currency)}</p>
                </div>
              </div>
            </div>

            <div className="p-4 space-y-4">
              {rideStep >= 0 && (
                <div className="bg-gradient-to-br from-gray-50 to-purple-50/30 rounded-2xl p-5 border border-gray-100">
                  <div className="flex justify-between mb-5 relative">
                    {RIDE_LABELS.map((label, i) => (
                      <div key={i} className="flex flex-col items-center gap-2 z-10" style={{ flex: 1 }}>
                        <div className={`w-10 h-10 rounded-2xl border-2 flex items-center justify-center transition-all duration-500
                          ${i < rideStep ? "bg-green-500 border-green-500 text-white shadow-lg shadow-green-200" :
                            i === rideStep ? "bg-gray-900 border-gray-900 text-white shadow-lg shadow-gray-300 ring-4 ring-gray-200" :
                            "bg-white border-gray-200 text-gray-300"}`}>
                          {i < rideStep ? <CheckCircle size={14}/> : RIDE_STEP_ICONS[i]}
                        </div>
                        <p className={`text-[9px] font-bold text-center max-w-[60px] ${i <= rideStep ? "text-gray-900" : "text-gray-400"}`}>{label}</p>
                      </div>
                    ))}
                  </div>
                  <div className="relative h-1.5 bg-gray-200 rounded-full overflow-hidden">
                    <div className="absolute top-0 left-0 h-full bg-gray-900 rounded-full transition-all duration-700 ease-out"
                      style={{ width: `${rideStep < 0 ? 0 : (rideStep / (RIDE_STEPS.length - 1)) * 100}%` }} />
                  </div>
                </div>
              )}

              <div className="relative">
                <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-2xl p-4 border border-green-100">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-green-200">
                      <MapPin size={18} className="text-white"/>
                    </div>
                    <div>
                      <p className="text-[10px] text-green-600 font-bold uppercase tracking-wider">Pickup</p>
                      <p className="text-sm font-bold text-gray-800 mt-0.5">{ride.pickupAddress}</p>
                    </div>
                  </div>
                </div>
                <div className="flex justify-center -my-1.5 relative z-10">
                  <div className="w-8 h-8 bg-white rounded-xl border-2 border-gray-200 flex items-center justify-center shadow-sm">
                    <ArrowDown size={14} className="text-gray-400"/>
                  </div>
                </div>
                <div className="bg-gradient-to-br from-red-50 to-pink-50 rounded-2xl p-4 border border-red-100">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-pink-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-red-200">
                      <MapPin size={18} className="text-white"/>
                    </div>
                    <div>
                      <p className="text-[10px] text-red-600 font-bold uppercase tracking-wider">Drop-off</p>
                      <p className="text-sm font-bold text-gray-800 mt-0.5">{ride.dropAddress}</p>
                    </div>
                  </div>
                </div>
              </div>

              {ride.customerName && (
                <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 rounded-2xl px-4 py-3.5 flex items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-blue-200">
                    <User size={22} className="text-white"/>
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] text-blue-500 font-bold uppercase tracking-wider">Passenger</p>
                    <p className="text-base font-black text-gray-900">{ride.customerName}</p>
                    {ride.customerPhone && <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1"><Phone size={10}/> {ride.customerPhone}</p>}
                  </div>
                </div>
              )}

              {ride.status === "accepted" && (
                <EstimatedArrivalBadge riderPos={riderPos} pickupLat={ride.pickupLat} pickupLng={ride.pickupLng} vehicleType={ride.type} />
              )}

              <div className="grid grid-cols-3 gap-2">
                {ride.status === "accepted" ? (
                  <NavButton label="Go to Pickup" lat={ride.pickupLat} lng={ride.pickupLng} address={ride.pickupAddress} color="orange" />
                ) : (
                  <NavButton label="Go to Drop" lat={ride.dropLat} lng={ride.dropLng} address={ride.dropAddress} color="blue" />
                )}
                <CallButton name={ride.customerName} phone={ride.customerPhone} />
                <ChatButton name={ride.customerName} />
              </div>
              {/* Turn-by-turn OSRM navigation */}
              {riderPos && ride.status === "accepted" && ride.pickupLat != null && ride.pickupLng != null && (
                <MapErrorBoundary>
                  <TurnByTurnPanel
                    fromLat={riderPos.lat} fromLng={riderPos.lng}
                    toLat={ride.pickupLat} toLng={ride.pickupLng}
                    label="Pickup"
                    riderLat={riderPos.lat} riderLng={riderPos.lng}
                  />
                </MapErrorBoundary>
              )}
              {riderPos && (ride.status === "arrived" || ride.status === "in_transit") && ride.dropLat != null && ride.dropLng != null && (
                <MapErrorBoundary>
                  <TurnByTurnPanel
                    fromLat={riderPos.lat} fromLng={riderPos.lng}
                    toLat={ride.dropLat} toLng={ride.dropLng}
                    label="Drop-off"
                    riderLat={riderPos.lat} riderLng={riderPos.lng}
                  />
                </MapErrorBoundary>
              )}

              {/* ── Visual route map ── */}
              {ride.pickupLat != null && ride.pickupLng != null && ride.dropLat != null && ride.dropLng != null && (
                <MapErrorBoundary fallbackMsg="Route map unavailable">
                  <RideRouteMap
                    pickupLat={ride.pickupLat} pickupLng={ride.pickupLng} pickupLabel={ride.pickupAddress}
                    dropLat={ride.dropLat} dropLng={ride.dropLng} dropLabel={ride.dropAddress}
                    riderLat={riderPos?.lat} riderLng={riderPos?.lng}
                  />
                </MapErrorBoundary>
              )}

              {config.features?.sos !== false && (ride.status === "accepted" || ride.status === "arrived" || ride.status === "in_transit") && (
                <div className="flex justify-end">
                  <SosButton rideId={ride.id} riderPos={riderPos} T={T} showToast={showToast} />
                </div>
              )}

              <div className="flex gap-2 pt-1">
                {ride.status === "accepted" && (
                  <button
                    onClick={() => {
                      if (navigator.geolocation) {
                        navigator.geolocation.getCurrentPosition(
                          (pos) => updateRideMut.mutate({ id: ride.id, status: "arrived", lat: pos.coords.latitude, lng: pos.coords.longitude }),
                          () => updateRideMut.mutate({ id: ride.id, status: "arrived" }),
                          { enableHighAccuracy: true, timeout: 5000 }
                        );
                      } else {
                        updateRideMut.mutate({ id: ride.id, status: "arrived" });
                      }
                    }}
                    disabled={updateRideMut.isPending}
                    onTouchStart={() => setPressedBtn("arrived")} onTouchEnd={() => setPressedBtn(null)}
                    className={`flex-1 bg-gray-900 text-white font-black rounded-2xl py-4 disabled:opacity-60 flex items-center justify-center gap-2 shadow-lg transition-transform ${pressedBtn === "arrived" ? "scale-[0.97]" : ""}`}>
                    <MapPin size={16}/> {T("arrivedAtPickup")}
                  </button>
                )}
                {["arrived", "accepted"].includes(ride.status) && !ride.otpVerified && (
                  <button
                    onClick={() => { setOtpInput(""); setShowOtpModal(true); }}
                    disabled={updateRideMut.isPending}
                    onTouchStart={() => setPressedBtn("otp")} onTouchEnd={() => setPressedBtn(null)}
                    className={`flex-1 bg-blue-600 text-white font-black rounded-2xl py-4 disabled:opacity-60 flex items-center justify-center gap-2 shadow-lg shadow-blue-200 transition-transform ${pressedBtn === "otp" ? "scale-[0.97]" : ""}`}>
                    <Shield size={16}/> Verify OTP to Start
                  </button>
                )}
                {ride.status === "arrived" && ride.otpVerified && (
                  <button
                    onClick={() => updateRideMut.mutate({ id: ride.id, status: "in_transit" })}
                    disabled={updateRideMut.isPending}
                    onTouchStart={() => setPressedBtn("start")} onTouchEnd={() => setPressedBtn(null)}
                    className={`flex-1 bg-gray-900 text-white font-black rounded-2xl py-4 disabled:opacity-60 flex items-center justify-center gap-2 shadow-lg transition-transform ${pressedBtn === "start" ? "scale-[0.97]" : ""}`}>
                    <Car size={16}/> {T("startRide")}
                  </button>
                )}
                {ride.status === "in_transit" && (
                  <button
                    onClick={() => updateRideMut.mutate({ id: ride.id, status: "completed" })}
                    disabled={updateRideMut.isPending}
                    onTouchStart={() => setPressedBtn("complete")} onTouchEnd={() => setPressedBtn(null)}
                    className={`flex-1 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-black rounded-2xl py-4 disabled:opacity-60 flex items-center justify-center gap-2 shadow-lg shadow-green-200 transition-transform ${pressedBtn === "complete" ? "scale-[0.97]" : ""}`}>
                    <CheckCircle size={16}/> {T("completeRide")}
                  </button>
                )}
                {(ride.status === "accepted" || ride.status === "arrived" || ride.status === "in_transit") && (
                  <button
                    onClick={() => { setCancelTarget("ride"); setShowCancelConfirm(true); }}
                    disabled={updateRideMut.isPending}
                    className="px-5 bg-red-50 text-red-600 font-bold rounded-2xl py-4 text-sm border-2 border-red-200 active:bg-red-100 transition-colors">
                    <X size={16}/>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── OTP Verification Modal ── */}
      {showOtpModal && ride && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 animate-[fadeIn_0.2s_ease-out]">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden animate-[slideUp_0.3s_ease-out]">
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 px-6 py-6 flex flex-col items-center gap-3 border-b border-blue-100">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-200">
                <Shield className="w-8 h-8 text-white" />
              </div>
              <div className="text-center">
                <p className="font-black text-gray-900 text-xl">Enter Customer OTP</p>
                <p className="text-gray-500 text-sm mt-1">Ask the customer for their 4-digit trip code</p>
              </div>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="space-y-1.5">
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={4}
                  value={otpInput}
                  onChange={e => { const val = e.target.value.replace(/\D/g, '').slice(0, 4); setOtpInput(val); }}
                  placeholder="_ _ _ _"
                  className="w-full text-center text-3xl font-black tracking-[0.5em] border-2 border-gray-200 rounded-2xl py-4 focus:border-blue-500 focus:outline-none"
                />
                {otpInput.length < 4 && (
                  <p className="text-center text-xs text-blue-500 font-medium">Enter the 4-digit code from the customer</p>
                )}
              </div>
              <button
                onClick={() => { if (otpInput.length === 4) verifyOtpMut.mutate({ id: ride.id, otp: otpInput }); }}
                disabled={otpInput.length !== 4 || verifyOtpMut.isPending}
                className="w-full bg-blue-600 text-white font-black rounded-2xl py-4 disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-blue-200">
                <CheckCircle size={18}/> {verifyOtpMut.isPending ? "Verifying…" : "Verify & Start Ride"}
              </button>
              <button onClick={() => setShowOtpModal(false)} className="w-full text-gray-400 font-bold py-2 text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showCancelConfirm && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 animate-[fadeIn_0.2s_ease-out]">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden animate-[slideUp_0.3s_ease-out]">
            <div className="bg-gradient-to-br from-red-50 to-pink-50 px-6 py-6 flex flex-col items-center gap-3 border-b border-red-100">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-red-500 to-pink-600 flex items-center justify-center shadow-lg shadow-red-200">
                <AlertTriangle className="w-8 h-8 text-white" />
              </div>
              <div className="text-center">
                <p className="font-black text-gray-900 text-xl">{T("cancelConfirm")} {cancelTarget === "order" ? T("deliveryLabel") : T("ride")}?</p>
                <p className="text-sm text-gray-500 mt-1.5">{T("actionNotReversible")}</p>
              </div>
            </div>
            <div className="p-5 space-y-4">
              <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl px-4 py-3.5 flex gap-3">
                <div className="w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Shield size={16} className="text-amber-600"/>
                </div>
                <p className="text-xs text-amber-800 font-medium leading-relaxed">{T("cancelWarning")}</p>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setShowCancelConfirm(false)}
                  className="flex-1 h-13 bg-gray-100 text-gray-700 font-bold rounded-xl active:bg-gray-200 transition-colors py-3">
                  {T("goBack")}
                </button>
                <button
                  onClick={() => {
                    setShowCancelConfirm(false);
                    if (cancelTarget === "order" && order) {
                      updateOrderMut.mutate({ id: order.id, status: "cancelled" });
                    } else if (cancelTarget === "ride" && ride) {
                      updateRideMut.mutate({ id: ride.id, status: "cancelled" });
                    }
                  }}
                  disabled={updateOrderMut.isPending || updateRideMut.isPending}
                  className="flex-1 h-13 bg-gradient-to-r from-red-600 to-pink-600 text-white font-bold rounded-xl disabled:opacity-60 active:scale-[0.97] transition-transform shadow-md shadow-red-200 py-3">
                  {(updateOrderMut.isPending || updateRideMut.isPending) ? T("cancelling") : T("yesCancel")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showNoPhotoWarning && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end justify-center pointer-events-auto animate-[fadeIn_0.15s_ease-out]">
          <div className="w-full max-w-sm mx-auto bg-white rounded-t-3xl px-6 py-6 shadow-2xl animate-[slideUp_0.2s_ease-out]">
            <div className="flex flex-col items-center gap-3 mb-5">
              <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center">
                <AlertTriangle size={28} className="text-amber-600"/>
              </div>
              <div className="text-center">
                <p className="text-base font-extrabold text-gray-900">No Photo Taken</p>
                <p className="text-sm text-gray-500 mt-1 leading-relaxed">Delivering without proof photo may cause disputes. Are you sure?</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowNoPhotoWarning(false)}
                className="flex-1 h-12 border-2 border-gray-200 text-gray-700 font-bold rounded-xl text-sm hover:bg-gray-50 transition-colors">
                Take Photo
              </button>
              <button onClick={() => { setShowNoPhotoWarning(false); if (order) handleMarkDelivered(order.id, true); }}
                disabled={proofUploading || updateOrderMut.isPending}
                className="flex-1 h-12 bg-amber-600 text-white font-bold rounded-xl text-sm hover:bg-amber-700 transition-colors disabled:opacity-60">
                Deliver Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {toastMsg && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-5 py-3.5 rounded-2xl shadow-2xl text-sm font-bold flex items-center gap-2.5 animate-[slideDown_0.3s_ease-out] max-w-[90vw] backdrop-blur-md ${toastIsError ? "bg-red-600/95 text-white" : "bg-gray-900/95 text-white"}`}>
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${toastIsError ? "bg-red-500" : "bg-green-500"}`}>
            {toastIsError
              ? <AlertTriangle size={14} className="text-white"/>
              : <CheckCircle size={14} className="text-white"/>
            }
          </div>
          {toastMsg}
        </div>
      )}
    </div>
  );
}
