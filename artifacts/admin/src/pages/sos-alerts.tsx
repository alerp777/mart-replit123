import { useState, useEffect, useCallback, useRef } from "react";
import { adminFetch, getAdminAccessToken } from "@/lib/adminFetcher";
import { LastUpdated } from "@/components/ui/LastUpdated";
import { AlertTriangle, RefreshCw, Phone, MapPin, Car, Clock, CheckCircle, CheckCheck, X } from "lucide-react";
import { PageHeader, StatCard } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { io, type Socket } from "socket.io-client";

type SosStatus = "pending" | "acknowledged" | "resolved";

type SosAlert = {
  id: string;
  userId: string;
  title: string;
  body: string;
  link: string | null;
  sosStatus: SosStatus;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolutionNotes: string | null;
  createdAt: string;
};

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" });
  } catch { return iso; }
}

function timeSince(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function parseBody(body: string) {
  const phoneMatch = body.match(/Phone: ([^\s·]+)/);
  const rideMatch  = body.match(/Ride: #([A-F0-9]+)/);
  const locMatch   = body.match(/Location: ([\d.]+),([\d.]+)/);
  const msgMatch   = body.match(/"(.+?)"/);
  return {
    phone:    phoneMatch?.[1],
    rideId:   rideMatch?.[1],
    location: locMatch ? { lat: locMatch[1], lng: locMatch[2] } : null,
    message:  msgMatch?.[1],
  };
}

const STATUS_CONFIG: Record<SosStatus, { label: string; color: string; bg: string; border: string }> = {
  pending:      { label: "Pending",      color: "text-red-600",    bg: "bg-red-50",    border: "border-red-200" },
  acknowledged: { label: "Acknowledged", color: "text-amber-600",  bg: "bg-amber-50",  border: "border-amber-200" },
  resolved:     { label: "Resolved",     color: "text-green-600",  bg: "bg-green-50",  border: "border-green-200" },
};

type Tab = "active" | "acknowledged" | "resolved";

/* ── Resolve Dialog ── */
function ResolveDialog({ alert, onClose, onResolved }: {
  alert: SosAlert;
  onClose: () => void;
  onResolved: (id: string) => void;
}) {
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleResolve = async () => {
    setLoading(true);
    setError(null);
    try {
      await adminFetch(`/sos/alerts/${alert.id}/resolve`, {
        method: "PATCH",
        body: JSON.stringify({ notes: notes.trim() || null }),
      });
      onResolved(alert.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve alert");
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCheck className="w-5 h-5 text-green-600" />
            <h2 className="text-lg font-bold text-foreground">Resolve SOS Alert</h2>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-red-50 border border-red-200 rounded-xl p-3">
          <p className="text-sm font-semibold text-red-800 truncate">{alert.title.replace("🆘 SOS Alert — ", "")}</p>
          <p className="text-xs text-red-600 mt-1">{formatTime(alert.createdAt)}</p>
        </div>

        <div>
          <label className="text-sm font-semibold text-foreground block mb-1.5">Resolution Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Describe how the situation was resolved, what actions were taken..."
            rows={3}
            className="w-full text-sm border border-border rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-green-500/30 focus:border-green-400"
          />
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="flex gap-2 pt-1">
          <Button variant="outline" onClick={onClose} className="flex-1 rounded-xl" disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={handleResolve}
            disabled={loading}
            className="flex-1 rounded-xl bg-green-600 hover:bg-green-700 text-white gap-2"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCheck className="w-4 h-4" />}
            {loading ? "Resolving..." : "Mark Resolved"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Alert Card ── */
function AlertCard({
  alert,
  onAcknowledge,
  onResolve,
  acknowledging,
}: {
  alert: SosAlert;
  onAcknowledge: (id: string) => void;
  onResolve: (alert: SosAlert) => void;
  acknowledging: string | null;
}) {
  const parsed = parseBody(alert.body);
  const isNew  = (Date.now() - new Date(alert.createdAt).getTime()) < 300_000;
  const status = alert.sosStatus;

  return (
    <Card className={`p-4 rounded-2xl shadow-sm transition-all ${
      status === "pending"      ? (isNew ? "border-red-200 bg-red-50/40" : "border-orange-200 bg-orange-50/20") :
      status === "acknowledged" ? "border-amber-200 bg-amber-50/20" :
                                   "border-green-200 bg-green-50/20"
    }`}>
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
          status === "pending"      ? "bg-red-100" :
          status === "acknowledged" ? "bg-amber-100" :
                                       "bg-green-100"
        }`}>
          <AlertTriangle className={`w-5 h-5 ${
            status === "pending"      ? "text-red-600" :
            status === "acknowledged" ? "text-amber-600" :
                                         "text-green-600"
          }`} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <p className="font-semibold text-sm text-foreground truncate">
              {alert.title.replace(/^🆘 SOS Alert — /, "").replace(/^🆘 sosAlert — /, "")}
            </p>
            {status === "pending" && isNew && (
              <Badge className="bg-red-600 text-white text-[10px] px-1.5 font-bold animate-pulse">NEW</Badge>
            )}
            <Badge variant="outline" className={`text-[10px] px-1.5 ${STATUS_CONFIG[status].color} border-current`}>
              {STATUS_CONFIG[status].label}
            </Badge>
            <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1 flex-shrink-0">
              <Clock className="w-3 h-3" /> {timeSince(alert.createdAt)}
            </span>
          </div>

          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground mb-2">
            {parsed.phone && (
              <a href={`tel:${parsed.phone}`} className="flex items-center gap-1 text-blue-600 font-medium hover:underline">
                <Phone className="w-3 h-3" /> {parsed.phone}
              </a>
            )}
            {parsed.rideId && (
              <span className="flex items-center gap-1 font-mono font-bold text-foreground">
                <Car className="w-3 h-3" /> #{parsed.rideId}
              </span>
            )}
            {parsed.location && (
              <a
                href={`https://www.google.com/maps?q=${parsed.location.lat},${parsed.location.lng}`}
                target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-emerald-600 font-medium hover:underline"
              >
                <MapPin className="w-3 h-3" /> View Location
              </a>
            )}
          </div>

          {parsed.message && (
            <p className="text-xs text-red-700 bg-red-100 border border-red-200 rounded-lg px-2.5 py-1.5 mb-2 font-medium">
              "{parsed.message}"
            </p>
          )}

          {status === "acknowledged" && alert.acknowledgedByName && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mb-2">
              <CheckCircle className="w-3 h-3 inline-block mr-1" />
              Acknowledged by <strong>{alert.acknowledgedByName}</strong> at {alert.acknowledgedAt ? formatTime(alert.acknowledgedAt) : "—"}
            </p>
          )}

          {status === "resolved" && (
            <div className="text-[11px] text-green-700 bg-green-50 border border-green-200 rounded-lg px-2.5 py-2 mb-2 space-y-0.5">
              <p>
                <CheckCheck className="w-3 h-3 inline-block mr-1" />
                Resolved by <strong>{alert.resolvedByName || alert.resolvedBy || "Admin"}</strong> at {alert.resolvedAt ? formatTime(alert.resolvedAt) : "—"}
              </p>
              {alert.resolutionNotes && (
                <p className="text-green-600 italic">"{alert.resolutionNotes}"</p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-[10px] text-muted-foreground">{formatTime(alert.createdAt)}</p>

            <div className="flex items-center gap-2">
              {status === "pending" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAcknowledge(alert.id)}
                  disabled={acknowledging === alert.id}
                  className="h-7 text-xs gap-1 border-amber-300 text-amber-700 hover:bg-amber-50 rounded-lg"
                >
                  {acknowledging === alert.id ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
                  ) : (
                    <CheckCircle className="w-3 h-3" />
                  )}
                  Acknowledge
                </Button>
              )}
              {(status === "pending" || status === "acknowledged") && (
                <Button
                  size="sm"
                  onClick={() => onResolve(alert)}
                  className="h-7 text-xs gap-1 bg-green-600 hover:bg-green-700 text-white rounded-lg"
                >
                  <CheckCheck className="w-3 h-3" />
                  Resolve
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default function SosAlerts() {
  const [alerts, setAlerts] = useState<SosAlert[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number>(0);
  const [total, setTotal]   = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [page, setPage]     = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("active");
  const [acknowledging, setAcknowledging] = useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = useState<SosAlert | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  /* ── Status filter from tab ── */
  const statusForTab = (t: Tab): string | undefined => {
    if (t === "active")       return "pending";
    if (t === "acknowledged") return "acknowledged";
    if (t === "resolved")     return "resolved";
    return undefined;
  };

  /* ── Load alerts ── */
  const loadAlerts = useCallback(async (p = 1, append = false, overrideTab?: Tab) => {
    setLoading(true);
    const currentTab = overrideTab ?? tab;
    const status = statusForTab(currentTab);
    try {
      const qs = `?page=${p}&limit=20${status ? `&status=${status}` : ""}`;
      const data = await adminFetch(`/sos/alerts${qs}`);
      const newAlerts: SosAlert[] = data.alerts || [];
      setAlerts(prev => append ? [...prev, ...newAlerts] : newAlerts);
      setTotal(data.total || 0);
      setHasMore(data.hasMore || false);
      setActiveCount(typeof data.activeCount === "number" ? data.activeCount : 0);
      setPage(p);
    } catch (err) {
    }
    setLastUpdatedAt(Date.now());
    setLoading(false);
  }, [tab]);

  /* ── Initial load + reload on tab change ── */
  useEffect(() => {
    loadAlerts(1, false, tab);
  }, [tab, loadAlerts]);

  /* ── Socket.io real-time connection ── */
  useEffect(() => {
    const token = getAdminAccessToken() ?? "";
    const socket = io(window.location.origin, {
      path: "/api/socket.io",
      query: { rooms: "admin-fleet" },
      auth: { token },
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setWsConnected(true);
      socket.emit("join", "admin-fleet");
    });
    socket.on("disconnect", () => setWsConnected(false));
    socket.on("connect_error", () => setWsConnected(false));

    /* New SOS alert arrives — prepend to active tab; update count regardless of current tab */
    socket.on("sos:new", (payload: SosAlert) => {
      setActiveCount(c => c + 1);
      if (tab === "active") {
        setAlerts(prev => [{ ...payload, sosStatus: "pending" }, ...prev.filter(a => a.id !== payload.id)]);
        setTotal(t => t + 1);
      }
    });

    /* Alert acknowledged — server emits full alert object */
    socket.on("sos:acknowledged", (payload: SosAlert) => {
      if (tab === "active") {
        /* Remove from active tab */
        setAlerts(prev => prev.filter(a => a.id !== payload.id));
        setTotal(t => Math.max(0, t - 1));
      } else if (tab === "acknowledged") {
        /* Upsert into acknowledged tab with full data */
        setAlerts(prev => {
          const alreadyIn = prev.some(a => a.id === payload.id);
          const filtered = prev.filter(a => a.id !== payload.id);
          if (!alreadyIn) setTotal(t => t + 1);
          return [payload, ...filtered];
        });
      }
    });

    /* Alert resolved — server emits full alert object */
    socket.on("sos:resolved", (payload: SosAlert) => {
      setActiveCount(c => Math.max(0, c - 1));

      if (tab === "active" || tab === "acknowledged") {
        /* Remove from current tab */
        setAlerts(prev => {
          const wasPresent = prev.some(a => a.id === payload.id);
          if (wasPresent) setTotal(t => Math.max(0, t - 1));
          return prev.filter(a => a.id !== payload.id);
        });
      } else if (tab === "resolved") {
        /* Upsert into resolved tab with full data */
        setAlerts(prev => {
          const alreadyIn = prev.some(a => a.id === payload.id);
          const filtered = prev.filter(a => a.id !== payload.id);
          if (!alreadyIn) setTotal(t => t + 1);
          return [payload, ...filtered];
        });
      }
    });

    return () => { socket.disconnect(); socketRef.current = null; };
  }, [tab]);

  /* ── Acknowledge handler ── */
  const handleAcknowledge = async (id: string) => {
    setAcknowledging(id);
    try {
      await adminFetch(`/sos/alerts/${id}/acknowledge`, { method: "PATCH", body: "{}" });
    } catch { /* socket will update UI anyway */ }
    setAcknowledging(null);
  };

  /* ── Resolved callback — removes from current view; socket event is the sole source of truth for counts ── */
  const handleResolved = (id: string) => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  };

  const TABS: { key: Tab; label: string }[] = [
    { key: "active",       label: "Active" },
    { key: "acknowledged", label: "Acknowledged" },
    { key: "resolved",     label: "Resolved" },
  ];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        icon={AlertTriangle}
        title="SOS Alerts"
        subtitle={`${total} alert${total !== 1 ? "s" : ""} in this view · ${activeCount} unresolved`}
        iconBgClass="bg-red-100"
        iconColorClass="text-red-600"
        actions={
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border ${wsConnected ? "bg-green-50 border-green-200 text-green-700" : "bg-gray-50 border-gray-200 text-gray-500"}`}>
              <span className={`w-2 h-2 rounded-full ${wsConnected ? "bg-green-500 animate-pulse" : "bg-gray-400"}`} />
              {wsConnected ? "Live" : "Connecting..."}
            </div>
            <LastUpdated dataUpdatedAt={lastUpdatedAt} onRefresh={() => loadAlerts(1)} isRefreshing={loading} />
            <Button size="sm" variant="outline" onClick={() => loadAlerts(1)} disabled={loading} className="h-9 text-xs gap-1.5">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        }
      />

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard icon={AlertTriangle} label="Total in View" value={total} iconBgClass="bg-gray-100" iconColorClass="text-gray-600" />
        <StatCard icon={Clock} label="Unresolved (Active)" value={activeCount} iconBgClass="bg-red-100" iconColorClass="text-red-600" onClick={() => setTab("active")} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted/50 p-1 rounded-xl border border-border/50">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-all ${
              tab === t.key
                ? "bg-white shadow-sm text-foreground border border-border/50"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            {t.key === "active" && activeCount > 0 && (
              <span className="text-[10px] font-bold bg-red-600 text-white px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                {activeCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {loading && alerts.length === 0 && (
        <div className="flex items-center justify-center py-16">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty state */}
      {alerts.length === 0 && !loading && (
        <Card className="p-10 flex flex-col items-center gap-4 text-center rounded-2xl border-border/50">
          <div className={`w-14 h-14 rounded-full flex items-center justify-center border ${
            tab === "resolved" ? "bg-green-50 border-green-200" : "bg-gray-50 border-gray-200"
          }`}>
            {tab === "resolved"
              ? <CheckCheck className="w-7 h-7 text-green-500" />
              : <AlertTriangle className="w-7 h-7 text-gray-400" />
            }
          </div>
          <p className="font-semibold text-lg text-foreground">
            {tab === "active" ? "No Active SOS Alerts" : tab === "acknowledged" ? "No Acknowledged Alerts" : "No Resolved Alerts"}
          </p>
          <p className="text-sm text-muted-foreground max-w-xs">
            {tab === "active" ? "All clear — no pending emergency alerts." :
             tab === "acknowledged" ? "No alerts are currently being handled." :
             "No alerts have been resolved yet."}
          </p>
        </Card>
      )}

      {/* Alert cards */}
      <div className="space-y-3">
        {alerts.map(alert => (
          <AlertCard
            key={alert.id}
            alert={alert}
            onAcknowledge={handleAcknowledge}
            onResolve={setResolveTarget}
            acknowledging={acknowledging}
          />
        ))}
      </div>

      {/* Load more */}
      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" onClick={() => loadAlerts(page + 1, true)} disabled={loading} className="rounded-xl gap-2">
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
            Load More
          </Button>
        </div>
      )}

      {/* Resolve dialog */}
      {resolveTarget && (
        <ResolveDialog
          alert={resolveTarget}
          onClose={() => setResolveTarget(null)}
          onResolved={handleResolved}
        />
      )}
    </div>
  );
}
