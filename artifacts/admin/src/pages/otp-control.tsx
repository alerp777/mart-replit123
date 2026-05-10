import { useState, useEffect, useCallback, useRef, type ElementType, type ReactNode } from "react";
import { adminFetch } from "@/lib/adminFetcher";
import { PageHeader } from "@/components/shared";
import {
  Shield, RefreshCw, CheckCircle2, XCircle, Loader2,
  Search, Clock, AlertTriangle, Users, ChevronRight,
  UserCheck, UserX, Info, ListChecks, Plus, Trash2, CalendarDays,
  ShieldOff, Activity, Zap, Gauge, KeyRound, Eye, EyeOff,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useOtpWhitelist, useAddOtpWhitelist, useUpdateOtpWhitelist, useDeleteOtpWhitelist, usePlatformSettings, useUpdatePlatformSettings } from "@/hooks/use-admin";

const BYPASS_CODE_REGEX = /^[0-9]{6}$/;

interface ApiError {
  status?: number;
  message?: string;
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && ("status" in value || "message" in value);
}

function errorMessage(value: unknown, fallback = "Something went wrong"): string {
  if (isApiError(value) && typeof value.message === "string" && value.message.length > 0) {
    return value.message;
  }
  if (value instanceof Error) return value.message;
  return fallback;
}

async function api(method: string, path: string, body?: unknown) {
  try {
    return await adminFetch(path, {
      method,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e: unknown) {
    if (isApiError(e) && e.status === 401) return null;
    throw e;
  }
}

function useCountdown(targetIso: string | null) {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!targetIso) { setRemaining(0); return; }
    const tick = () => {
      const diff = Math.max(0, new Date(targetIso).getTime() - Date.now());
      setRemaining(diff);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetIso]);
  return remaining;
}

function fmtCountdown(ms: number) {
  if (ms <= 0) return "Expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" });
}

function generateBypassCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

type OTPStatus = { isGloballyDisabled: boolean; disabledUntil: string | null; activeBypassCount: number };

type UserRow = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  otpBypassUntil: string | null;
};

type OtpWhitelistEntry = {
  id: string;
  identifier: string;
  label?: string;
  bypassCode: string;
  isActive: boolean;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

type OtpAuditEvent = "login_otp_bypass" | "login_global_otp_bypass" | "otp_send_bypassed";

type AuditRow = {
  id: string;
  event: OtpAuditEvent;
  createdAt: string;
  ip: string;
  userId?: string | null;
  phone?: string | null;
  name?: string | null;
};

function isBypassActive(otpBypassUntil: string | null | undefined): boolean {
  if (!otpBypassUntil) return false;
  const ts = new Date(otpBypassUntil).getTime();
  if (Number.isNaN(ts)) return false;
  return ts > Date.now();
}

/* ── Design primitives ───────────────────────────────────────────────────── */

function ProCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-border bg-white shadow-sm overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

function CardHeader({ icon: Icon, label, sub, color, gradient }: {
  icon: ElementType; label: string; sub?: string; color: string; gradient: string;
}) {
  return (
    <div className={`px-5 py-4 border-b border-border/60 ${gradient}`}>
      <div className="flex items-center gap-2.5">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color} bg-white/60 backdrop-blur-sm`}>
          <Icon className="w-4 h-4" />
        </div>
        <div>
          <h3 className="text-sm font-bold font-display text-gray-900 leading-none">{label}</h3>
          {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, accent }: {
  icon: ElementType; label: string; value: ReactNode; sub?: string; accent: string;
}) {
  return (
    <div className={`rounded-2xl border bg-white shadow-sm px-5 py-4 flex items-center gap-4`}>
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${accent}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
        <p className="text-xl font-bold font-display text-foreground leading-tight mt-0.5">{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function AvatarInitial({ name }: { name: string | null }) {
  const initials = (name ?? "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center flex-shrink-0 text-white text-xs font-bold shadow-sm">
      {initials}
    </div>
  );
}

/* ── Main page ───────────────────────────────────────────────────────────── */

type DeliveryOtpResult = {
  rideId: string;
  otp: string | null;
  otpVerified: boolean;
  displayStatus: "pending" | "used" | "expired";
  rideStatus: string;
  arrivedAt: string | null;
  createdAt: string;
  otpAttempts: {
    count: number;
    firstAt: string | null;
    expiresAt: string | null;
  };
};

export default function OtpControl() {
  const { toast } = useToast();

  const [status, setStatus]           = useState<OTPStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("");
  const remaining = useCountdown(status?.disabledUntil ?? null);

  const [query, setQuery]             = useState("");
  const [users, setUsers]             = useState<UserRow[]>([]);
  const [searching, setSearching]     = useState(false);
  const [bypassMins, setBypassMins]   = useState<Record<string, string>>({});
  const searchAbortRef = useRef<AbortController | null>(null);

  const [auditRows, setAuditRows]     = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  /* ── Global-suspension confirmation modal ── */
  const [suspendModal, setSuspendModal] = useState<{ open: boolean; mins: number }>({ open: false, mins: 0 });
  const [suspendReason, setSuspendReason] = useState("");
  const [suspendPending, setSuspendPending] = useState(false);

  /* ── OTP Rate Limiting card ── */
  const { data: settingsData } = usePlatformSettings();
  const updateSettings = useUpdatePlatformSettings();
  const rawSettings: Array<{ key: string; value: string }> = settingsData?.settings ?? [];
  const getSetting = (key: string, fallback: string) =>
    rawSettings.find((s: { key: string; value: string }) => s.key === key)?.value ?? fallback;
  const [rlPhone, setRlPhone] = useState("");
  const [rlIp, setRlIp]       = useState("");
  const [rlWindow, setRlWindow] = useState("");
  const [rlSaving, setRlSaving] = useState(false);
  useEffect(() => {
    if (rawSettings.length > 0) {
      setRlPhone(getSetting("security_otp_max_per_phone", "5"));
      setRlIp(getSetting("security_otp_max_per_ip", "20"));
      setRlWindow(getSetting("security_otp_window_min", "60"));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsData]);

  /* ── Delivery OTP Viewer ── */
  const [rideIdInput, setRideIdInput]     = useState("");
  const [otpLookupResult, setOtpLookupResult] = useState<{
    rideId: string; otp: string | null; otpStatus: "Pending" | "Used" | "Expired";
    createdAt: string; rideStatus: string;
  } | null>(null);
  const [otpLookupError, setOtpLookupError] = useState<string | null>(null);
  const [otpLookupLoading, setOtpLookupLoading] = useState(false);
  const [otpVisible, setOtpVisible] = useState(false);
  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const d = await api("GET", "/otp/status");
      if (d?.data) setStatus(d.data);
    } catch (err) {
      toast({ title: "Failed to load OTP status", variant: "destructive" });
    } finally { setStatusLoading(false); }
  }, [toast]);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const d = await api("GET", "/otp/audit?page=1");
      if (d?.data?.entries) {
        const bypass = (d.data.entries as AuditRow[]).filter(e =>
          e.event === "login_otp_bypass" || e.event === "login_global_otp_bypass" || e.event === "otp_send_bypassed"
        ).slice(0, 20);
        setAuditRows(bypass);
      }
    } catch (err) {
      toast({ title: "Failed to load audit log", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally { setAuditLoading(false); }
  }, [toast]);

  const loadRateLimits = useCallback(async () => {
    try {
      const d = await adminFetch("/platform-settings");
      const settings: Array<{ key: string; value: string }> = d?.settings ?? [];
      const get = (key: string, def: string) => settings.find(s => s.key === key)?.value ?? def;
      const perPhone = get("security_otp_max_per_phone", "5");
      const perIp    = get("security_otp_max_per_ip", "10");
      const winMin   = get("security_otp_window_min", "10");
      setRlPhone(perPhone); setRlIp(perIp); setRlWindow(winMin);
    } catch (err) {
    }
  }, []);

  useEffect(() => { loadStatus(); loadAudit(); loadRateLimits(); }, [loadStatus, loadAudit, loadRateLimits]);

  useEffect(() => {
    if (status?.isGloballyDisabled && remaining === 0 && status.disabledUntil) {
      const t = setTimeout(loadStatus, 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [remaining, status?.isGloballyDisabled, status?.disabledUntil, loadStatus]);

  const openSuspendModal = (mins: number) => {
    if (!mins || mins <= 0) return;
    setSuspendReason("");
    setSuspendModal({ open: true, mins });
  };

  const confirmSuspend = async () => {
    if (!suspendReason.trim()) return;
    setSuspendPending(true);
    try {
      const d = await api("POST", "/otp/disable", { minutes: suspendModal.mins, reason: suspendReason.trim() });
      if (d?.data) {
        toast({ title: "OTP Suspended", description: `All OTPs suspended for ${suspendModal.mins} minute(s).` });
        loadStatus(); loadAudit();
        setSuspendModal({ open: false, mins: 0 });
        setSuspendReason("");
      } else {
        toast({ title: "Error", description: d?.error ?? "Failed", variant: "destructive" });
      }
    } catch (e: unknown) {
      toast({ title: "Error", description: errorMessage(e, "Failed to suspend OTPs."), variant: "destructive" });
    } finally {
      setSuspendPending(false);
    }
  };

  const saveRateLimits = async () => {
    const phone = parseInt(rlPhone, 10);
    const ip    = parseInt(rlIp, 10);
    const win   = parseInt(rlWindow, 10);
    if (isNaN(phone) || phone < 1 || isNaN(ip) || ip < 1 || isNaN(win) || win < 1) {
      toast({ title: "Invalid values", description: "All rate limit fields must be positive integers.", variant: "destructive" });
      return;
    }
    setRlSaving(true);
    try {
      await updateSettings.mutateAsync([
        { key: "security_otp_max_per_phone", value: String(phone) },
        { key: "security_otp_max_per_ip",    value: String(ip) },
        { key: "security_otp_window_min",     value: String(win) },
      ]);
      toast({ title: "Rate limits saved", description: "OTP rate limiting settings updated." });
    } catch (e: unknown) {
      toast({ title: "Failed to save", description: errorMessage(e, "Could not update rate limit settings."), variant: "destructive" });
    } finally {
      setRlSaving(false);
    }
  };

  const lookupDeliveryOtp = async () => {
    const id = rideIdInput.trim();
    if (!id) return;
    setOtpLookupLoading(true);
    setOtpLookupError(null);
    setOtpLookupResult(null);
    setOtpVisible(false);
    try {
      const d = await api("GET", `/otp/delivery-otp/${encodeURIComponent(id)}`);
      if (d?.data) {
        setOtpLookupResult(d.data);
      } else {
        setOtpLookupError(d?.error ?? "Ride not found.");
      }
    } catch (e: unknown) {
      if (isApiError(e) && e.status === 404) {
        setOtpLookupError("Ride not found. Check the Ride ID and try again.");
      } else {
        setOtpLookupError(errorMessage(e, "Failed to look up delivery OTP."));
      }
    } finally {
      setOtpLookupLoading(false);
    }
  };

  const searchUsers = useCallback(async () => {
    if (!query.trim() || query.trim().length < 2) return;
    searchAbortRef.current?.abort();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;
    setSearching(true);
    try {
      const d = await adminFetch(
        `/users/search?q=${encodeURIComponent(query)}&limit=20`,
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted) return;
      setUsers((d?.users ?? []).map((u: UserRow) => ({
        id: u.id, name: u.name, phone: u.phone,
        email: u.email ?? null, otpBypassUntil: u.otpBypassUntil ?? null,
      })));
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (isApiError(e) && (e as { name?: string }).name === "AbortError") return;
      toast({ title: "Search failed", description: errorMessage(e, "Could not load users."), variant: "destructive" });
    } finally {
      if (searchAbortRef.current === ctrl) { searchAbortRef.current = null; setSearching(false); }
    }
  }, [query, toast]);

  useEffect(() => {
    const t = setTimeout(() => { if (query.trim().length >= 2) searchUsers(); }, 400);
    return () => clearTimeout(t);
  }, [query, searchUsers]);

  useEffect(() => () => { searchAbortRef.current?.abort(); }, []);

  const grantBypass = async (userId: string, mins: number) => {
    try {
      const d = await api("POST", `/users/${userId}/otp/bypass`, { minutes: mins });
      if (d?.data?.bypassUntil) {
        toast({ title: "Bypass Granted", description: `OTP bypass active for ${mins} minute(s).` });
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, otpBypassUntil: d.data.bypassUntil } : u));
        loadStatus();
      } else {
        toast({ title: "Error", description: d?.error ?? "Failed", variant: "destructive" });
      }
    } catch (e: unknown) {
      if (isApiError(e) && e.status === 409) {
        toast({ title: "Bypass already active", description: errorMessage(e, "User already has an active OTP bypass."), variant: "destructive" });
        return;
      }
      toast({ title: "Error", description: errorMessage(e, "Failed to grant bypass."), variant: "destructive" });
    }
  };

  const cancelBypass = async (userId: string) => {
    await api("DELETE", `/users/${userId}/otp/bypass`);
    toast({ title: "Bypass Removed" });
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, otpBypassUntil: null } : u));
    loadStatus();
  };

  const eventLabel: Record<OtpAuditEvent, string> = {
    login_otp_bypass: "Per-user bypass",
    login_global_otp_bypass: "Global suspension",
    otp_send_bypassed: "OTP send bypassed",
  };

  const eventColors: Record<OtpAuditEvent, string> = {
    login_otp_bypass: "bg-blue-500",
    login_global_otp_bypass: "bg-orange-500",
    otp_send_bypassed: "bg-purple-500",
  };

  const eventBadgeColors: Record<OtpAuditEvent, string> = {
    login_otp_bypass: "bg-blue-50 text-blue-700 border-blue-200",
    login_global_otp_bypass: "bg-orange-50 text-orange-700 border-orange-200",
    otp_send_bypassed: "bg-purple-50 text-purple-700 border-purple-200",
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* ── Header ── */}
      <PageHeader
        icon={Shield}
        title="OTP Control Center"
        subtitle="Unified panel for all OTP settings — global suspension, per-user bypasses, and whitelist management."
        iconBgClass="bg-indigo-100"
        iconColorClass="text-indigo-700"
        actions={
          <Button size="sm" variant="outline" onClick={() => { loadStatus(); loadAudit(); }} disabled={statusLoading} className="gap-1.5 rounded-xl">
            <RefreshCw className={`w-3.5 h-3.5 ${statusLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          icon={status?.isGloballyDisabled ? ShieldOff : Shield}
          label="Global OTP"
          value={
            status === null
              ? <span className="flex items-center gap-1"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></span>
              : status.isGloballyDisabled
                ? <span className="text-red-600">Suspended</span>
                : <span className="text-green-600">Active</span>
          }
          sub={status?.isGloballyDisabled && remaining > 0 ? `Restores in ${fmtCountdown(remaining)}` : "All users must verify"}
          accent={status?.isGloballyDisabled ? "bg-red-100 text-red-600" : "bg-green-100 text-green-600"}
        />
        <StatCard
          icon={Users}
          label="Active Bypasses"
          value={status === null ? "—" : status.activeBypassCount}
          sub="Users skipping OTP"
          accent="bg-blue-100 text-blue-600"
        />
        <StatCard
          icon={Activity}
          label="Audit Events"
          value={auditLoading ? <span className="flex items-center gap-1"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></span> : auditRows.length}
          sub="No-OTP logins recorded"
          accent="bg-purple-100 text-purple-600"
        />
      </div>

      {/* ── 1. GLOBAL SUSPENSION ── */}
      <ProCard>
        <CardHeader
          icon={ShieldOff}
          label="Global OTP Suspension"
          sub="Temporarily disable OTP for all users during SMS outages"
          color="text-indigo-600"
          gradient="bg-gradient-to-r from-indigo-50/80 to-slate-50"
        />
        <div className="p-5 space-y-4">

          {/* Status banner */}
          {status === null ? (
            <div className="h-16 rounded-xl bg-muted/30 border border-border flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : status.isGloballyDisabled ? (
            <div className="rounded-xl bg-red-50 border-2 border-red-200 p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-bold text-red-800">OTPs are GLOBALLY SUSPENDED</p>
                  <span className="inline-flex items-center gap-1 text-xs font-mono font-bold bg-red-200 text-red-800 px-2 py-0.5 rounded-lg">
                    <Clock className="w-3 h-3" />{fmtCountdown(remaining)}
                  </span>
                </div>
                <p className="text-xs text-red-600 mt-0.5">All users can log in without OTP. Auto-restores when the timer expires.</p>
              </div>
              <Button size="sm" variant="destructive" onClick={() => api("DELETE", "/otp/disable").then(() => { toast({ title: "OTPs Restored", description: "Global OTP suspension lifted." }); loadStatus(); loadAudit(); })} className="shrink-0 rounded-xl">
                Restore Now
              </Button>
            </div>
          ) : (
            <div className="rounded-xl bg-green-50 border border-green-200 p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm font-bold text-green-800">OTPs are ACTIVE</p>
                <p className="text-xs text-green-600 mt-0.5">
                  {status.activeBypassCount > 0
                    ? `${status.activeBypassCount} user(s) have per-user bypass active.`
                    : "All users must verify OTP on login."}
                </p>
              </div>
            </div>
          )}

          {/* Info notice */}
          <div className="flex items-start gap-2.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
            <span>Use during SMS/OTP delivery outages. OTP verification auto-resumes when the timer expires. New registrations during suspension will have <code className="bg-amber-100 px-1 py-0.5 rounded text-[10px]">is_verified = false</code>.</span>
          </div>

          {/* Suspend buttons */}
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">Suspend for</p>
            <div className="flex flex-wrap gap-2">
              {[
                { label: "30 min", mins: 30 },
                { label: "1 hour", mins: 60 },
                { label: "2 hours", mins: 120 },
                { label: "24 hours", mins: 1440 },
              ].map(opt => (
                <button
                  key={opt.mins}
                  onClick={() => openSuspendModal(opt.mins)}
                  disabled={statusLoading}
                  className="px-3.5 py-2 rounded-xl text-xs font-semibold border border-red-200 text-red-700 bg-white hover:bg-red-50 transition-colors disabled:opacity-50 shadow-sm"
                >
                  {opt.label}
                </button>
              ))}
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  placeholder="Custom min"
                  value={customMinutes}
                  onChange={e => setCustomMinutes(e.target.value)}
                  className="w-28 h-8 text-xs rounded-xl"
                  min={1}
                  max={10080}
                />
                <button
                  onClick={() => {
                    const m = parseInt(customMinutes, 10);
                    if (Number.isNaN(m) || m <= 0) {
                      toast({ title: "Invalid duration", description: "Enter a whole number of minutes greater than 0.", variant: "destructive" });
                      return;
                    }
                    openSuspendModal(m);
                  }}
                  disabled={!customMinutes || statusLoading}
                  className="px-3.5 py-2 h-8 rounded-xl text-xs font-semibold border border-red-200 text-red-700 bg-white hover:bg-red-50 transition-colors disabled:opacity-50 shadow-sm"
                >
                  Suspend
                </button>
              </div>
            </div>
          </div>
        </div>
      </ProCard>

      {/* ── Suspension Confirmation Modal ── */}
      <Dialog open={suspendModal.open} onOpenChange={open => { if (!open && !suspendPending) setSuspendModal({ open: false, mins: 0 }); }}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <ShieldOff className="w-5 h-5" /> Confirm Global OTP Suspension
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-1">
            <div className="bg-red-50 border border-red-200 rounded-xl p-3">
              <p className="text-sm text-red-800">
                You are about to suspend OTP verification for <strong>all users</strong> for{" "}
                <strong>{suspendModal.mins >= 60
                  ? `${suspendModal.mins / 60 === Math.floor(suspendModal.mins / 60) ? suspendModal.mins / 60 + " hour(s)" : suspendModal.mins + " minutes"}`
                  : `${suspendModal.mins} minute(s)`}</strong>.
                Users will be able to log in without receiving an OTP code.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground uppercase tracking-wider">
                Reason for suspension <span className="text-red-500">*</span>
              </label>
              <textarea
                value={suspendReason}
                onChange={e => setSuspendReason(e.target.value)}
                placeholder="e.g. SMS gateway outage — Twilio down, users cannot receive OTP codes"
                className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-300 h-24"
              />
              <p className="text-[11px] text-muted-foreground">This reason is written to the audit log and included in the admin notification.</p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 rounded-xl"
                onClick={() => setSuspendModal({ open: false, mins: 0 })}
                disabled={suspendPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="flex-1 rounded-xl gap-1.5"
                onClick={confirmSuspend}
                disabled={!suspendReason.trim() || suspendPending}
              >
                {suspendPending ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Suspending…</> : <><ShieldOff className="w-3.5 h-3.5" /> Confirm Suspension</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── 2. PER-USER BYPASS ── */}
      <ProCard>
        <CardHeader
          icon={Users}
          label="Per-User OTP Bypass"
          sub="Users here always skip OTP — highest-priority bypass, overrides global setting"
          color="text-blue-600"
          gradient="bg-gradient-to-r from-blue-50/80 to-slate-50"
        />
        <div className="p-5 space-y-4">

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            {searching && (
              <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
            )}
            <Input
              className="pl-10 pr-10 rounded-xl h-10 text-sm focus-visible:ring-blue-400"
              placeholder="Search by name, phone, or email…"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </div>

          {/* Results */}
          {users.length > 0 && (
            <div className="space-y-2">
              {users.map(user => {
                const bypassActive = isBypassActive(user.otpBypassUntil);
                return (
                  <div
                    key={user.id}
                    className={`rounded-xl border p-3.5 transition-colors ${bypassActive ? "bg-blue-50/60 border-blue-200" : "bg-white border-border"}`}
                  >
                    <div className="flex items-center gap-3">
                      <AvatarInitial name={user.name} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-foreground">{user.name ?? "Unnamed"}</p>
                          {bypassActive ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-green-100 text-green-700 border border-green-200 px-1.5 py-0.5 rounded-full">
                              <UserCheck className="w-2.5 h-2.5" /> Bypass Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-muted text-muted-foreground border border-border px-1.5 py-0.5 rounded-full">
                              <UserX className="w-2.5 h-2.5" /> Normal OTP
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">{user.phone ?? user.email ?? "—"}</p>
                        {bypassActive && user.otpBypassUntil && (
                          <p className="text-[10px] text-green-700 mt-0.5 flex items-center gap-1">
                            <Clock className="w-3 h-3" /> Until {fmtDate(user.otpBypassUntil)}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-border/50">
                      {bypassActive ? (
                        <button
                          onClick={() => cancelBypass(user.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-red-200 text-red-700 bg-white hover:bg-red-50 transition-colors"
                        >
                          <XCircle className="w-3 h-3" /> Remove Bypass
                        </button>
                      ) : (
                        <>
                          {[
                            { label: "15 min", mins: 15 },
                            { label: "1 hour", mins: 60 },
                            { label: "24 hrs", mins: 1440 },
                          ].map(opt => (
                            <button
                              key={opt.mins}
                              onClick={() => grantBypass(user.id, opt.mins)}
                              className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 transition-colors"
                            >
                              {opt.label}
                            </button>
                          ))}
                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              placeholder="min"
                              value={bypassMins[user.id] ?? ""}
                              onChange={e => setBypassMins(p => ({ ...p, [user.id]: e.target.value }))}
                              className="w-16 h-7 text-xs rounded-lg"
                              min={1}
                            />
                            <button
                              onClick={() => { const m = parseInt(bypassMins[user.id] ?? "", 10); if (m > 0) grantBypass(user.id, m); }}
                              className="px-2.5 py-1.5 h-7 rounded-lg text-xs font-semibold border border-border text-foreground bg-white hover:bg-muted/40 transition-colors"
                            >
                              Custom
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!searching && query.trim().length >= 2 && users.length === 0 && (
            <div className="text-center py-8 text-sm text-muted-foreground bg-muted/20 rounded-xl border border-dashed border-border">
              No users found matching "{query}"
            </div>
          )}

          {!query.trim() && (
            <div className="text-center py-8 text-sm text-muted-foreground bg-muted/10 rounded-xl border border-dashed border-border">
              <Search className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
              Type at least 2 characters to search users
            </div>
          )}
        </div>
      </ProCard>

      {/* ── 3. AUDIT LOG ── */}
      <ProCard>
        <CardHeader
          icon={Activity}
          label="No-OTP Login Audit"
          sub="Every login that bypassed OTP, per-user or via global suspension"
          color="text-purple-600"
          gradient="bg-gradient-to-r from-purple-50/80 to-slate-50"
        />
        <div className="p-5">
          {auditLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading audit log…
            </div>
          ) : auditRows.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground bg-muted/10 rounded-xl border border-dashed border-border">
              <Clock className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
              No no-OTP logins recorded yet
            </div>
          ) : (
            <div className="space-y-px">
              {auditRows.map((row, i) => (
                <div
                  key={row.id}
                  className={`flex items-center gap-3 px-3 py-2.5 text-xs transition-colors hover:bg-muted/30 ${i === 0 ? "rounded-t-xl" : ""} ${i === auditRows.length - 1 ? "rounded-b-xl" : ""}`}
                >
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${eventColors[row.event] ?? "bg-gray-400"}`} />
                  <span className="font-mono text-muted-foreground w-36 shrink-0 hidden sm:block">{fmtDate(row.createdAt)}</span>
                  <ChevronRight className="w-3 h-3 text-muted-foreground/50 flex-shrink-0 hidden sm:block" />
                  <span className="font-semibold text-foreground flex-1 truncate">{row.name ?? row.phone ?? row.userId ?? "—"}</span>
                  <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${eventBadgeColors[row.event] ?? "bg-muted text-muted-foreground border-border"}`}>
                    {eventLabel[row.event] ?? row.event}
                  </span>
                  <span className="text-muted-foreground font-mono shrink-0 hidden md:block">{row.ip}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-border/50">
            <button
              onClick={loadAudit}
              disabled={auditLoading}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${auditLoading ? "animate-spin" : ""}`} />
              Refresh log
            </button>
          </div>
        </div>
      </ProCard>

      {/* ── 4. OTP RATE LIMITING ── */}
      <ProCard>
        <CardHeader
          icon={Gauge}
          label="OTP Rate Limiting"
          sub="Max OTP requests per phone/IP before the user is throttled"
          color="text-orange-600"
          gradient="bg-gradient-to-r from-orange-50/80 to-slate-50"
        />
        <div className="p-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-orange-400" />
                Max per phone
              </label>
              <Input
                type="number"
                value={rlPhone}
                onChange={e => setRlPhone(e.target.value)}
                className="rounded-xl text-sm h-9"
                min={1}
                max={100}
                placeholder="5"
              />
              <p className="text-[10px] text-muted-foreground">OTPs per phone per window</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-rose-400" />
                Max per IP
              </label>
              <Input
                type="number"
                value={rlIp}
                onChange={e => setRlIp(e.target.value)}
                className="rounded-xl text-sm h-9"
                min={1}
                max={500}
                placeholder="20"
              />
              <p className="text-[10px] text-muted-foreground">OTPs per IP per window</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                Window (minutes)
              </label>
              <Input
                type="number"
                value={rlWindow}
                onChange={e => setRlWindow(e.target.value)}
                className="rounded-xl text-sm h-9"
                min={1}
                max={1440}
                placeholder="60"
              />
              <p className="text-[10px] text-muted-foreground">Rolling window duration</p>
            </div>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <Button
              size="sm"
              className="rounded-xl gap-1.5 bg-orange-600 hover:bg-orange-700 text-white"
              onClick={saveRateLimits}
              disabled={rlSaving || updateSettings.isPending}
            >
              {rlSaving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</> : "Save Rate Limits"}
            </Button>
            <p className="text-xs text-muted-foreground">Changes apply to new OTP requests immediately.</p>
          </div>
        </div>
      </ProCard>

      {/* ── 5. DELIVERY OTP VIEWER ── */}
      <ProCard>
        <CardHeader
          icon={KeyRound}
          label="Delivery OTP Viewer"
          sub="Look up the current handover OTP for a ride or parcel delivery"
          color="text-teal-600"
          gradient="bg-gradient-to-r from-teal-50/80 to-slate-50"
        />
        <div className="p-5 space-y-4">
          <div className="flex gap-2">
            <Input
              className="flex-1 rounded-xl h-10 text-sm font-mono"
              placeholder="Enter Ride ID or Delivery ID…"
              value={rideIdInput}
              onChange={e => { setRideIdInput(e.target.value); setOtpLookupResult(null); setOtpLookupError(null); }}
              onKeyDown={e => { if (e.key === "Enter") lookupDeliveryOtp(); }}
            />
            <Button
              size="sm"
              className="rounded-xl px-4 gap-1.5 bg-teal-600 hover:bg-teal-700 text-white h-10"
              onClick={lookupDeliveryOtp}
              disabled={!rideIdInput.trim() || otpLookupLoading}
            >
              {otpLookupLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Look Up"}
            </Button>
          </div>

          {otpLookupError && (
            <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl px-3.5 py-3">
              <XCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-800">{otpLookupError}</p>
            </div>
          )}

          {otpLookupResult && (
            <div className="bg-teal-50 border border-teal-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-teal-700 uppercase tracking-wider">Ride {otpLookupResult.rideId}</p>
                <Badge
                  variant="outline"
                  className={`text-[10px] font-bold ${
                    otpLookupResult.otpStatus === "Used"    ? "bg-green-100 text-green-700 border-green-300" :
                    otpLookupResult.otpStatus === "Expired" ? "bg-red-100 text-red-700 border-red-300" :
                    "bg-amber-100 text-amber-700 border-amber-300"
                  }`}
                >
                  {otpLookupResult.otpStatus}
                </Badge>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <p className="text-[10px] text-muted-foreground mb-1">OTP Code</p>
                  {otpLookupResult.otp ? (
                    <div className="flex items-center gap-2">
                      <code className={`font-mono font-bold text-xl tracking-[0.3em] text-teal-900 bg-white border border-teal-300 px-3 py-1.5 rounded-lg ${!otpVisible ? "blur-sm select-none" : ""}`}>
                        {otpLookupResult.otp}
                      </code>
                      <button
                        onClick={() => setOtpVisible(v => !v)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                        title={otpVisible ? "Hide OTP" : "Reveal OTP"}
                      >
                        {otpVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground italic">No OTP generated</span>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[10px] text-muted-foreground mb-0.5">Ride Status</p>
                  <p className="text-xs font-semibold text-foreground capitalize">{otpLookupResult.rideStatus}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">{new Date(otpLookupResult.createdAt).toLocaleString()}</p>
                </div>
              </div>
              {!otpVisible && otpLookupResult.otp && (
                <p className="text-[11px] text-teal-600 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Click the eye icon to reveal the OTP — only do this when assisting a customer.
                </p>
              )}
            </div>
          )}

          {!otpLookupResult && !otpLookupError && !otpLookupLoading && (
            <div className="text-center py-6 text-sm text-muted-foreground bg-muted/10 rounded-xl border border-dashed border-border">
              <KeyRound className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
              Enter a Ride ID above to look up its delivery OTP
            </div>
          )}
        </div>
      </ProCard>

      {/* ── 6. WHITELIST ── */}
      <WhitelistSection />
    </div>
  );
}

/* ── Whitelist section ───────────────────────────────────────────────────── */

function WhitelistSection() {
  const { toast } = useToast();
  const { data, isLoading, refetch } = useOtpWhitelist();
  const addEntry = useAddOtpWhitelist();
  const updateEntry = useUpdateOtpWhitelist();
  const deleteEntry = useDeleteOtpWhitelist();

  const [identifier, setIdentifier] = useState("");
  const [label, setLabel] = useState("");
  const [bypassCode, setBypassCode] = useState(() => generateBypassCode());
  const [expiresAt, setExpiresAt] = useState("");
  const [adding, setAdding] = useState(false);

  const entries: Array<OtpWhitelistEntry> = data?.entries ?? [];

  async function handleAdd() {
    if (!identifier.trim()) {
      toast({ title: "Identifier required", variant: "destructive" });
      return;
    }
    const code = bypassCode?.trim() || generateBypassCode();
    if (!BYPASS_CODE_REGEX.test(code)) {
      toast({ title: "Invalid bypass code", description: "Use a 6-digit numeric code.", variant: "destructive" });
      return;
    }
    setAdding(true);
    try {
      await addEntry.mutateAsync({
        identifier: identifier.trim(),
        label: label.trim() || undefined,
        bypassCode: code,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      toast({ title: "Added to whitelist", description: `Bypass code ${code} is active.` });
      setIdentifier(""); setLabel(""); setBypassCode(generateBypassCode()); setExpiresAt("");
    } catch (e: unknown) {
      toast({ title: "Error", description: errorMessage(e, "Could not add whitelist entry."), variant: "destructive" });
    } finally { setAdding(false); }
  }

  async function handleToggle(entry: OtpWhitelistEntry) {
    try {
      await updateEntry.mutateAsync({ id: entry.id, isActive: !entry.isActive });
      toast({ title: entry.isActive ? "Whitelist entry disabled" : "Whitelist entry enabled", description: entry.identifier });
    } catch (e: unknown) {
      toast({ title: "Error", description: errorMessage(e, "Could not update whitelist entry."), variant: "destructive" });
    }
  }

  async function handleDelete(id: string, identifier: string) {
    if (!confirm(`Remove "${identifier}" from whitelist?`)) return;
    try { await deleteEntry.mutateAsync(id); toast({ title: "Removed from whitelist" }); }
    catch (e: unknown) { toast({ title: "Error", description: errorMessage(e, "Could not delete entry."), variant: "destructive" }); }
  }

  return (
    <ProCard>
      <CardHeader
        icon={ListChecks}
        label="OTP Whitelist"
        sub="Per-identity bypass — phones/emails that accept a fixed 6-digit code instead of real SMS"
        color="text-indigo-600"
        gradient="bg-gradient-to-r from-indigo-50/80 to-slate-50"
      />
      <div className="p-5 space-y-5">

        {/* Info */}
        <div className="flex items-start gap-2.5 text-xs text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-xl p-3">
          <Zap className="w-4 h-4 flex-shrink-0 mt-0.5 text-indigo-500" />
          <span>Perfect for App Store reviewers and testers. Identifiers here bypass real SMS and accept the configured 6-digit bypass code.</span>
        </div>

        {/* Add form */}
        <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Add Entry</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <Input
              className="rounded-xl h-9 text-sm"
              placeholder="Phone or email (identifier)"
              value={identifier}
              onChange={e => setIdentifier(e.target.value)}
            />
            <Input
              className="rounded-xl h-9 text-sm"
              placeholder="Label (e.g. Apple Reviewer)"
              value={label}
              onChange={e => setLabel(e.target.value)}
            />
            <div className="relative">
              <Input
                className="rounded-xl h-9 text-sm font-mono pr-16"
                placeholder="Bypass code (6 digits)"
                value={bypassCode}
                onChange={e => setBypassCode(e.target.value)}
              />
              <button
                onClick={() => setBypassCode(generateBypassCode())}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-indigo-600 hover:text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded"
              >
                New
              </button>
            </div>
            <Input
              className="rounded-xl h-9 text-sm"
              type="datetime-local"
              placeholder="Expires (optional)"
              value={expiresAt}
              onChange={e => setExpiresAt(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            className="w-full rounded-xl gap-1.5 h-9"
            onClick={handleAdd}
            disabled={adding}
          >
            {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Add to Whitelist
          </Button>
        </div>

        {/* List */}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading whitelist…
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground bg-muted/10 rounded-xl border border-dashed border-border">
            <ListChecks className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
            No whitelist entries yet
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map((entry: OtpWhitelistEntry) => (
              <div
                key={entry.id}
                className={`flex items-center gap-3 px-3.5 py-3 rounded-xl border text-sm transition-colors ${
                  entry.isActive
                    ? "bg-indigo-50/50 border-indigo-200"
                    : "bg-muted/20 border-border opacity-60"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-foreground truncate">{entry.identifier}</p>
                    {entry.isActive
                      ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                      : <XCircle className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                    }
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {entry.label && (
                      <span className="text-xs text-muted-foreground">{entry.label}</span>
                    )}
                    <span className="text-[10px] font-mono bg-white border border-border text-foreground px-1.5 py-0.5 rounded-md">
                      {entry.bypassCode}
                    </span>
                    {entry.expiresAt && (
                      <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <CalendarDays className="w-3 h-3" />
                        {new Date(entry.expiresAt) < new Date()
                          ? <span className="text-red-500 font-medium">Expired</span>
                          : `Expires ${new Date(entry.expiresAt).toLocaleDateString()}`
                        }
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleToggle(entry)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
                      entry.isActive
                        ? "border-border text-muted-foreground bg-white hover:bg-muted/40"
                        : "border-green-200 text-green-700 bg-green-50 hover:bg-green-100"
                    }`}
                  >
                    {entry.isActive ? "Disable" : "Enable"}
                  </button>
                  <button
                    onClick={() => handleDelete(entry.id, entry.identifier)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg border border-border text-red-400 hover:text-red-600 hover:bg-red-50 hover:border-red-200 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="pt-1">
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Refresh whitelist
          </button>
        </div>
      </div>
    </ProCard>
  );
}
