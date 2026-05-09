import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bus, Users, CheckCircle, Clock, ChevronRight, AlertCircle, Play, Square, Navigation, TrendingUp, Wallet, Timer } from "lucide-react";
import { apiFetch } from "../lib/api";
import { enqueueAction, subscribeActionSuccess } from "../lib/offline/queueManager";
import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "../lib/auth";
import { MapContainer, TileLayer, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface DriverMetrics {
  tripsToday: number;
  earningsToday: number;
  onlineHoursToday: number;
  passengersToday: number;
  tripsThisMonth: number;
  earningsThisMonth: number;
  cancellationsLast30d: number;
  noShowsLast30d: number;
}

type SeatTier = "window" | "aisle" | "economy";

const TIER_BADGE: Record<SeatTier, { bg: string; text: string; label: string }> = {
  window:  { bg: "bg-amber-100", text: "text-amber-700", label: "Window" },
  aisle:   { bg: "bg-blue-100", text: "text-blue-700", label: "Aisle" },
  economy: { bg: "bg-green-100", text: "text-green-700", label: "Economy" },
};

interface VanSchedule {
  id: string;
  routeId: string;
  departureTime: string;
  returnTime?: string;
  routeName?: string;
  routeFrom?: string;
  routeTo?: string;
  totalSeats?: number;
  date: string;
  bookedCount: number;
  bookedSeats: number[];
  vanCode?: string | null;
  tripStatus?: string;
  seatTiers?: Record<string, SeatTier>;
}

interface Passenger {
  id: string;
  seatNumbers: number[];
  seatTiers?: Record<string, SeatTier> | null;
  status: string;
  passengerName?: string;
  passengerPhone?: string;
  paymentMethod: string;
  fare: string;
  boardedAt?: string;
  userName?: string;
  userPhone?: string;
}

async function fetchTodaySchedules(): Promise<VanSchedule[]> {
  const data = await apiFetch("/van/driver/today");
  return data ?? [];
}

async function fetchPassengers(scheduleId: string, date: string): Promise<Passenger[]> {
  const data = await apiFetch(`/van/driver/schedules/${scheduleId}/date/${date}/passengers`);
  return data ?? [];
}

async function markBoarded(bookingId: string): Promise<void> {
  await apiFetch(`/van/driver/bookings/${bookingId}/board`, {
    method: "PATCH",
    body: JSON.stringify({ boarded: true, boardedAt: new Date().toISOString() }),
  });
}

async function startTrip(scheduleId: string, date: string): Promise<void> {
  await apiFetch(`/van/driver/schedules/${scheduleId}/date/${date}/start-trip`, { method: "POST", body: JSON.stringify({}) });
}

async function completeTrip(scheduleId: string, date: string): Promise<void> {
  await apiFetch(`/van/driver/schedules/${scheduleId}/date/${date}/complete`, { method: "PATCH", body: JSON.stringify({}) });
}

async function sendLocation(scheduleId: string, date: string, lat: number, lng: number): Promise<void> {
  await apiFetch(`/van/driver/location`, {
    method: "POST",
    body: JSON.stringify({ scheduleId, date, latitude: lat, longitude: lng }),
  });
}

async function fetchMetrics(): Promise<DriverMetrics> {
  const data = await apiFetch("/van/driver/metrics");
  return (data ?? {}) as DriverMetrics;
}

interface EligibilityResult {
  eligible: boolean;
  reason: string | null;
  conditions: Array<{ id: string; conditionType: string; severity: string; reason: string | null }>;
  triggered: Array<{ ruleName: string; metric: string; value: number }>;
  triggeredCount?: number;
}

async function fetchEligibility(): Promise<EligibilityResult> {
  const data = await apiFetch("/van/driver/eligibility");
  return (data ?? { eligible: true, reason: null, conditions: [], triggered: [], triggeredCount: 0 }) as EligibilityResult;
}

const STATUS_STYLE: Record<string, string> = {
  confirmed: "bg-blue-100 text-blue-700",
  boarded:   "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-700",
  completed: "bg-gray-100 text-gray-600",
};

function AutoPanMap({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => { map.setView([lat, lng], map.getZoom()); }, [lat, lng]);
  return null;
}

const riderMarkerIcon = L.divIcon({
  className: "",
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  html: `<div style="width:24px;height:24px;display:flex;align-items:center;justify-content:center;">
    <div style="background:#4f46e5;border-radius:50%;width:16px;height:16px;border:3px solid white;box-shadow:0 0 0 4px rgba(79,70,229,0.3);"></div>
  </div>`,
});

export default function VanDriver() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [selectedSchedule, setSelectedSchedule] = useState<VanSchedule | null>(null);
  const [error, setError] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);
  const [riderPos, setRiderPos] = useState<[number, number] | null>(null);
  const gpsIntervalRef = useRef<number | null>(null);

  /* Optimistic "Trip Ending…" state shown immediately when completeTrip fails
     offline so the screen never freezes waiting for the queue to sync. */
  const [tripEndingOffline, setTripEndingOffline] = useState(false);

  const { data: schedules = [], isLoading } = useQuery<VanSchedule[]>({
    queryKey: ["van-driver-today"],
    queryFn: fetchTodaySchedules,
    refetchInterval: 60_000,
  });

  const { data: metrics } = useQuery<DriverMetrics>({
    queryKey: ["van-driver-metrics"],
    queryFn: fetchMetrics,
    refetchInterval: 30_000,
  });

  const { data: eligibility, isLoading: loadingEligibility } = useQuery<EligibilityResult>({
    queryKey: ["van-driver-eligibility"],
    queryFn: fetchEligibility,
    refetchInterval: 60_000,
  });

  const { data: passengers = [], isLoading: loadingPassengers } = useQuery<Passenger[]>({
    queryKey: ["van-passengers", selectedSchedule?.id, selectedSchedule?.date],
    queryFn: () => selectedSchedule ? fetchPassengers(selectedSchedule.id, selectedSchedule.date) : Promise.resolve([]),
    enabled: !!selectedSchedule,
    refetchInterval: 15_000,
  });

  const boardMut = useMutation({
    mutationFn: (bookingId: string) => markBoarded(bookingId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["van-passengers"] }),
    onError: (e: Error, bookingId: string) => {
      const looksLikeNetErr = /network|fetch|timeout|offline/i.test(e?.message || "");
      if (looksLikeNetErr) {
        enqueueAction("board_passenger", bookingId, { boardedAt: new Date().toISOString() }).catch(() => {});
      }
      setError(e.message);
    },
  });

  const startMut = useMutation({
    mutationFn: () => selectedSchedule ? startTrip(selectedSchedule.id, selectedSchedule.date) : Promise.resolve(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["van-driver-today"] });
      startGpsBroadcast();
    },
    onError: (e: Error) => setError(e.message),
  });

  const completeMut = useMutation({
    mutationFn: () => selectedSchedule ? completeTrip(selectedSchedule.id, selectedSchedule.date) : Promise.resolve(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["van-passengers"] });
      qc.invalidateQueries({ queryKey: ["van-driver-today"] });
      stopGpsBroadcast();
      setTripEndingOffline(false);
      setSelectedSchedule(null);
    },
    onError: (e: Error) => {
      /* Persist to IndexedDB queue so the trip completion survives connectivity loss */
      const looksLikeNetErr = /network|fetch|timeout|offline/i.test(e?.message || "");
      if (looksLikeNetErr && selectedSchedule) {
        enqueueAction("complete_trip", selectedSchedule.id, { date: selectedSchedule.date }).catch(() => {});
        /* Immediately show optimistic "Trip Ending…" state so the UI never appears
           frozen while the action waits in the offline queue to sync. */
        setTripEndingOffline(true);
      } else {
        setError(e.message);
      }
    },
  });

  /* When the offline queue replays complete_trip successfully, reset the
     optimistic state and refresh the schedule/passenger data. */
  useEffect(() => {
    if (!selectedSchedule) return;
    const scheduleId = selectedSchedule.id;
    const unsub = subscribeActionSuccess("complete_trip", (action) => {
      if (action.entityId !== scheduleId) return;
      setTripEndingOffline(false);
      stopGpsBroadcast();
      qc.invalidateQueries({ queryKey: ["van-driver-today"] });
      qc.invalidateQueries({ queryKey: ["van-passengers"] });
      setSelectedSchedule(null);
    });
    return unsub;
  }, [selectedSchedule?.id]);

  /* G6: Surface geolocation errors to the UI rather than swallowing them.
     G7: Use an in-flight flag so the 5s interval never queues a second
         getCurrentPosition while the first is still running.
     G8: Stop the broadcast when tripStatus leaves in_progress (e.g. dispatcher
         cancels server-side). We reuse the existing `error` state for the
         UI banner so users see the same red bar that mutation failures use,
         rather than introducing a parallel display surface. */
  const gpsInflightRef = useRef<boolean>(false);
  const highAccuracyRef = useRef<boolean>(true);
  const setGpsError = (msg: string | null) => {
    /* Only overwrite the error banner when there's something to show — never
       clobber a mutation error with a stale clear, or vice versa. */
    if (msg) setError(msg);
  };

  function startGpsBroadcast() {
    if (!selectedSchedule) return;
    if (!navigator?.geolocation) {
      /* G6: Don't silently say "broadcasting" when geolocation is unavailable. */
      setGpsError("Location services are not available on this device.");
      return;
    }
    setBroadcasting(true);
    setGpsError(null);
    const schedId = selectedSchedule.id;
    const schedDate = selectedSchedule.date;
    gpsIntervalRef.current = window.setInterval(() => {
      /* G7: Skip this tick if the previous getCurrentPosition is still
         pending. Stacking concurrent requests on weak GPS used to ANR. */
      if (gpsInflightRef.current) return;
      gpsInflightRef.current = true;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          gpsInflightRef.current = false;
          setGpsError(null);
          setRiderPos([pos.coords.latitude, pos.coords.longitude]);
          sendLocation(schedId, schedDate, pos.coords.latitude, pos.coords.longitude).catch(() => {});
        },
        (err) => {
          gpsInflightRef.current = false;
          /* G6: Map the standard PositionError codes to actionable UI strings.
             On PERMISSION_DENIED we stop the broadcast — there is no point
             retrying since the OS won't re-prompt without a user gesture. */
          if (err.code === 1 /* PERMISSION_DENIED */) {
            setGpsError("Location permission denied. Enable it in your browser/OS settings to broadcast.");
            stopGpsBroadcast();
          } else if (err.code === 3 /* TIMEOUT */) {
            /* G6: Fall back to coarse accuracy on timeout. */
            highAccuracyRef.current = false;
            setGpsError("GPS timed out — falling back to coarse accuracy.");
          } else {
            setGpsError("Couldn't read location — try moving to an open-sky area.");
          }
        },
        { enableHighAccuracy: highAccuracyRef.current, timeout: 4500, maximumAge: 2000 }
      );
    }, 5000);
  }

  function stopGpsBroadcast() {
    setBroadcasting(false);
    gpsInflightRef.current = false;
    if (gpsIntervalRef.current) {
      clearInterval(gpsIntervalRef.current);
      gpsIntervalRef.current = null;
    }
  }

  useEffect(() => {
    return () => { stopGpsBroadcast(); };
  }, []);

  useEffect(() => {
    if (selectedSchedule?.tripStatus === "in_progress" && !broadcasting) {
      startGpsBroadcast();
    } else if (selectedSchedule?.tripStatus !== "in_progress" && broadcasting) {
      /* G8: tripStatus left in_progress (server-side cancel, completion, etc.)
         — stop broadcasting immediately rather than waiting for navigation. */
      stopGpsBroadcast();
    }
  }, [selectedSchedule?.tripStatus, broadcasting]);

  const boardedCount = passengers.filter(p => p.status === "boarded" || p.status === "completed").length;
  const confirmedCount = passengers.filter(p => p.status === "confirmed").length;
  const isTripInProgress = selectedSchedule?.tripStatus === "in_progress" || broadcasting;

  if (isLoading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-gray-500 text-sm">Loading your schedule…</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-gradient-to-br from-indigo-900 to-indigo-700 px-4 pt-12 pb-6 text-white">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center">
            <Bus className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold">Van Service</h1>
            <p className="text-indigo-200 text-sm">Today's route assignments</p>
          </div>
          {schedules.length > 0 && schedules[0]?.vanCode && (
            <div className="bg-white/15 px-3 py-1.5 rounded-lg">
              <p className="text-xs text-indigo-200">Van Code</p>
              <p className="text-lg font-bold text-white">{schedules[0].vanCode}</p>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-5 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
            <button className="ml-auto font-bold" onClick={() => setError("")}>×</button>
          </div>
        )}

        {/* Eligibility banner — blocks van mode entry when account conditions are active */}
        {!loadingEligibility && eligibility && !eligibility.eligible && (
          <div className="bg-red-50 border border-red-300 rounded-2xl p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="text-sm font-bold text-red-800">Van driver mode unavailable</div>
                <div className="text-xs text-red-700 mt-1">{eligibility.reason || "Your account has an active restriction."}</div>
                {eligibility.conditions.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {eligibility.conditions.slice(0, 3).map((c) => (
                      <li key={c.id} className="text-[11px] text-red-700">
                        • <span className="font-semibold">{c.severity}</span> — {c.reason || c.conditionType}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="text-[11px] text-red-600 mt-2">Contact support to lift the restriction.</div>
              </div>
            </div>
          </div>
        )}

        {/* Driver daily metrics */}
        {!selectedSchedule && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Trips Today", value: metrics?.tripsToday ?? 0, icon: TrendingUp, color: "text-indigo-600 bg-indigo-50" },
              { label: "Earnings", value: `Rs ${(metrics?.earningsToday ?? 0).toLocaleString()}`, icon: Wallet, color: "text-emerald-600 bg-emerald-50" },
              { label: "Online Hrs", value: (metrics?.onlineHoursToday ?? 0).toFixed(1), icon: Timer, color: "text-amber-600 bg-amber-50" },
            ].map((m) => (
              <div key={m.label} className={`rounded-xl p-3 ${m.color}`}>
                <m.icon className="w-4 h-4 mb-1.5 opacity-70" />
                <div className="text-lg font-bold leading-tight">{m.value}</div>
                <div className="text-[11px] font-medium opacity-80 mt-0.5">{m.label}</div>
              </div>
            ))}
          </div>
        )}

        {!selectedSchedule && metrics && (metrics.tripsThisMonth > 0 || metrics.earningsThisMonth > 0) && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-3 grid grid-cols-2 gap-3 text-center">
            <div>
              <div className="text-xs text-gray-500 font-medium">This Month</div>
              <div className="text-base font-bold text-gray-900">{metrics.tripsThisMonth} trips</div>
              <div className="text-xs text-gray-600">Rs {metrics.earningsThisMonth.toLocaleString()} earned</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 font-medium">Last 30 Days</div>
              <div className="text-base font-bold text-gray-900">{metrics.cancellationsLast30d} cancellations</div>
              <div className="text-xs text-gray-600">{metrics.noShowsLast30d} no-shows</div>
            </div>
          </div>
        )}

        {!selectedSchedule ? (
          <>
            {schedules.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center">
                <Bus className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 font-medium">No schedules today</p>
                <p className="text-gray-400 text-sm mt-1">You have no van routes assigned for today.</p>
              </div>
            ) : (
              schedules.map(s => (
                <button
                  key={s.id}
                  onClick={() => setSelectedSchedule(s)}
                  className="w-full bg-white rounded-2xl border border-gray-100 shadow-sm p-4 text-left hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      {s.vanCode && (
                        <div className="inline-flex items-center gap-1.5 bg-indigo-50 text-indigo-700 text-xs font-bold px-2 py-1 rounded-md mb-2">
                          <Bus className="w-3.5 h-3.5" />{s.vanCode}
                        </div>
                      )}
                      <div className="font-semibold text-gray-900">{s.routeName || s.routeId}</div>
                      <div className="text-sm text-gray-500 mt-0.5">{s.routeFrom} → {s.routeTo}</div>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="flex items-center gap-1 text-sm text-indigo-600 font-medium">
                          <Clock className="w-4 h-4" />{s.departureTime}
                        </span>
                        <span className="flex items-center gap-1 text-sm text-gray-500">
                          <Users className="w-4 h-4" />{s.bookedCount}/{s.totalSeats ?? "?"} booked
                        </span>
                      </div>
                      {s.tripStatus === "in_progress" && (
                        <span className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                          <Navigation className="w-3 h-3" />In Progress
                        </span>
                      )}
                    </div>
                    <ChevronRight className="w-5 h-5 text-gray-400 mt-1" />
                  </div>
                </button>
              ))
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <button onClick={() => { setSelectedSchedule(null); stopGpsBroadcast(); }} className="text-indigo-600 font-semibold text-sm hover:underline flex items-center gap-1">
                ← Back
              </button>
              <span className="text-gray-400">|</span>
              <span className="font-semibold text-gray-800">{selectedSchedule.routeName}</span>
              {selectedSchedule.vanCode && (
                <span className="bg-indigo-100 text-indigo-700 text-xs font-bold px-2 py-0.5 rounded-md ml-auto">{selectedSchedule.vanCode}</span>
              )}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Boarded", value: boardedCount, color: "text-green-600 bg-green-50" },
                { label: "Pending", value: confirmedCount, color: "text-blue-600 bg-blue-50" },
                { label: "Total", value: passengers.length, color: "text-gray-700 bg-gray-50" },
              ].map(s => (
                <div key={s.label} className={`rounded-xl p-3 text-center ${s.color}`}>
                  <div className="text-2xl font-bold">{s.value}</div>
                  <div className="text-xs font-medium mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>

            {/* GPS broadcasting indicator */}
            {broadcasting && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-3 flex items-center gap-2">
                <div className="w-2.5 h-2.5 bg-green-500 rounded-full animate-pulse" />
                <span className="text-green-700 text-sm font-medium">Broadcasting GPS to passengers</span>
              </div>
            )}

            {/* Live location map — shows rider's position while broadcasting */}
            {isTripInProgress && riderPos && (
              <div className="relative rounded-2xl overflow-hidden border border-indigo-100 shadow-sm" style={{ height: 180 }}>
                <MapContainer
                  center={riderPos}
                  zoom={15}
                  style={{ width: "100%", height: "100%" }}
                  zoomControl={false}
                  dragging={false}
                  scrollWheelZoom={false}
                  doubleClickZoom={false}
                  keyboard={false}
                  attributionControl={false}
                >
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  <Marker position={riderPos} icon={riderMarkerIcon} />
                  <AutoPanMap lat={riderPos[0]} lng={riderPos[1]} />
                </MapContainer>
                <div className="absolute bottom-1 left-1 z-[1000] bg-indigo-600/80 text-white text-[9px] font-bold px-2 py-0.5 rounded-full pointer-events-none">
                  Your Location
                </div>
              </div>
            )}

            {/* Start Trip button */}
            {!isTripInProgress && passengers.length > 0 && (
              <button
                onClick={() => {
                  if (confirm("Start the trip? This will begin GPS broadcasting to all passengers.")) {
                    startMut.mutate();
                  }
                }}
                disabled={startMut.isPending}
                className="w-full bg-green-600 text-white font-semibold py-3 rounded-xl hover:bg-green-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
              >
                <Play className="w-5 h-5" />
                {startMut.isPending ? "Starting…" : "Start Trip"}
              </button>
            )}

            {/* Seat Map */}
            {selectedSchedule.totalSeats && selectedSchedule.totalSeats > 0 && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Seat Map</p>
                <div
                  className="grid gap-1.5"
                  style={{ gridTemplateColumns: `repeat(${Math.min(8, selectedSchedule.totalSeats)}, 1fr)` }}
                >
                  {Array.from({ length: selectedSchedule.totalSeats }, (_, i) => i + 1).map(seatNum => {
                    const passenger = passengers.find(p =>
                      (Array.isArray(p.seatNumbers) ? p.seatNumbers : []).includes(seatNum)
                    );
                    const status = passenger?.status;
                    const cls = !passenger
                      ? "bg-gray-100 text-gray-400"
                      : status === "boarded" || status === "completed"
                        ? "bg-green-500 text-white"
                        : status === "confirmed"
                          ? "bg-blue-500 text-white"
                          : "bg-red-100 text-red-500";
                    return (
                      <div
                        key={seatNum}
                        title={passenger ? `${passenger.passengerName || passenger.userName || "Passenger"} · ${status}` : "Free"}
                        className={`rounded text-[10px] font-bold flex items-center justify-center h-7 ${cls} cursor-default select-none`}
                      >
                        {seatNum}
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-3 mt-2.5 flex-wrap">
                  <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-gray-100 border border-gray-200" /><span className="text-[10px] text-gray-500">Free</span></div>
                  <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-blue-500" /><span className="text-[10px] text-gray-500">Confirmed</span></div>
                  <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-green-500" /><span className="text-[10px] text-gray-500">Boarded</span></div>
                </div>
              </div>
            )}

            {/* Passengers */}
            {loadingPassengers ? (
              <div className="text-center py-8 text-gray-400">Loading passengers…</div>
            ) : passengers.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-100 p-6 text-center">
                <Users className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                <p className="text-gray-500 text-sm">No confirmed bookings for today yet.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {passengers.map(p => (
                  <div key={p.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="font-semibold text-gray-900">{p.passengerName || p.userName || "Unknown"}</div>
                        <div className="text-sm text-gray-500">{p.passengerPhone || p.userPhone || ""}</div>
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLE[p.status] || "bg-gray-100 text-gray-600"}`}>{p.status}</span>
                          <span className="text-xs text-gray-400">{p.paymentMethod} · Rs {parseFloat(p.fare).toFixed(0)}</span>
                        </div>
                        <div className="flex gap-1 mt-1.5 flex-wrap">
                          {(Array.isArray(p.seatNumbers) ? p.seatNumbers as number[] : []).map(s => {
                            const tier = (p.seatTiers?.[String(s)] || "aisle") as SeatTier;
                            const tb = TIER_BADGE[tier];
                            return (
                              <span key={s} className={`${tb.bg} ${tb.text} text-xs font-bold rounded px-1.5 py-0.5 inline-flex items-center gap-1`}>
                                Seat {s}
                                <span className="text-[10px] font-medium opacity-75">{tb.label}</span>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                      {p.status === "confirmed" && (
                        <button
                          onClick={() => boardMut.mutate(p.id)}
                          disabled={boardMut.isPending}
                          className="ml-3 flex items-center gap-1.5 bg-green-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60"
                        >
                          <CheckCircle className="w-4 h-4" />
                          Board
                        </button>
                      )}
                      {(p.status === "boarded" || p.status === "completed") && (
                        <div className="ml-3 flex items-center gap-1 text-green-600 text-xs font-semibold">
                          <CheckCircle className="w-4 h-4" />Boarded
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* End Trip button */}
            {isTripInProgress && passengers.some(p => p.status === "confirmed" || p.status === "boarded") && (
              <>
                {tripEndingOffline && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2 text-amber-800 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" />
                    <span>No connection — will sync automatically when back online.</span>
                  </div>
                )}
                <button
                  onClick={() => {
                    if (tripEndingOffline) return;
                    if (confirm("End the trip? This will complete all boarded passengers and stop GPS broadcasting.")) {
                      completeMut.mutate();
                    }
                  }}
                  disabled={completeMut.isPending || tripEndingOffline}
                  className="w-full bg-red-600 text-white font-semibold py-3 rounded-xl hover:bg-red-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  <Square className="w-5 h-5" />
                  {completeMut.isPending || tripEndingOffline ? "Trip Ending…" : "End Trip"}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
