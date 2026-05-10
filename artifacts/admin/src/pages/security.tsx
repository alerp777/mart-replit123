import { useState, useEffect, useCallback } from "react";
import { adminFetch, fetchAdminAbsolute, fetchAdminAbsoluteResponse } from "@/lib/adminFetcher";
import { PageHeader } from "@/components/shared";
import {
  Shield, Save, RefreshCw, Info, AlertTriangle,
  CheckCircle2, XCircle, Lock,
  KeyRound, FileText, Zap, Bike, BarChart3, Globe,
  ShieldCheck, Loader2, Users, Download, Bug, RotateCcw,
  X, Wifi, Clock, ChevronRight, Activity, LogOut, CheckCircle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Toggle, Field, SecretInput } from "@/components/AdminShared";
import { LastUpdated } from "@/components/ui/LastUpdated";

type SecTab = "auth" | "authmethods" | "ratelimit" | "gps" | "passwords" | "uploads" | "fraud" | "dataexports" | "tokenaudit";

type SecurityDashboard = Record<string, unknown>;

type LockoutEntry = {
  phone: string;
  minutesLeft?: number;
  attempts?: number;
};

type SecurityEvent = {
  severity: "critical" | "high" | "medium" | "low";
  type: string;
  details: string;
  timestamp: string;
};

type MfaStatus = {
  mfaEnabled: boolean;
};

type DataExportLog = {
  id: string;
  userId: string | null;
  maskedPhone: string | null;
  ip: string;
  requestedAt: string;
  completedAt: string | null;
  success: boolean;
};

type MfaSetupData = {
  secret: string;
  qrCodeDataUrl: string;
};

type TokenAuditEvent = {
  id: string;
  userId: string;
  userPhone: string | null;
  userName: string | null;
  authMethod: string | null;
  tokenFamilyId: string | null;
  revokedReason: string | null;
  eventType: "rotation" | "breach" | "reuse" | "security" | "expired" | "other";
  revokedAt: string | null;
  issuedAt: string;
};

type TimelineToken = {
  id: string;
  authMethod: string | null;
  revoked: boolean;
  revokedReason: string | null;
  status: "active" | "rotation" | "breach" | "reuse" | "security" | "expired" | "other";
  usedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  issuedAt: string;
};

type TimelineFamily = {
  familyId: string | null;
  startedAt: string;
  tokens: TimelineToken[];
};

type UserTimeline = {
  userId: string;
  userPhone: string | null;
  userName: string | null;
  totalTokens: number;
  activeCount: number;
  breachCount: number;
  familyCount: number;
  families: TimelineFamily[];
};

const SEC_TABS: { id: SecTab; label: string; emoji: string; active: string; desc: string }[] = [
  { id: "auth",        label: "Auth & Sessions",  emoji: "🔐", active: "bg-indigo-600",  desc: "OTP bypass, MFA, login lockout, session durations, live lockouts" },
  { id: "authmethods", label: "Auth Methods",      emoji: "🔑", active: "bg-cyan-600",    desc: "Per-role login method toggles: Phone OTP, Email OTP, Username/Password, Social, Magic Link, 2FA, Biometric" },
  { id: "ratelimit",   label: "Rate Limiting",     emoji: "🛡️", active: "bg-blue-600",    desc: "API throttling and VPN/TOR blocking" },
  { id: "gps",         label: "GPS & Location",    emoji: "📍", active: "bg-green-600",   desc: "Rider tracking, spoof detection, geofence" },
  { id: "passwords",   label: "Passwords",         emoji: "🔑", active: "bg-amber-600",   desc: "Password policy, JWT rotation, token expiry" },
  { id: "uploads",     label: "File Uploads",      emoji: "📁", active: "bg-teal-600",    desc: "Upload limits, allowed file types, compression" },
  { id: "fraud",       label: "Fraud Detection",   emoji: "🚨", active: "bg-red-600",     desc: "Fake orders, IP auto-block, live IP manager, account limits" },
  { id: "dataexports", label: "Data Exports",      emoji: "📦", active: "bg-violet-600",  desc: "GDPR data export audit log — who exported their data and when, plus suspicious API pattern events" },
  { id: "tokenaudit",  label: "Token Audit",       emoji: "🔄", active: "bg-rose-600",    desc: "Refresh token rotation trail — rotations, reuse attempts, family invalidations per user" },
];

function SecPanel({ title, icon: Icon, color, children }: { title: string; icon: React.ElementType; color: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-white p-5 space-y-4">
      <div className={`flex items-center gap-2 ${color}`}>
        <Icon className="w-4 h-4" />
        <h4 className="text-sm font-bold">{title}</h4>
      </div>
      {children}
    </div>
  );
}

export default function SecurityPage() {
  const { toast } = useToast();
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const [savedValues, setSavedValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number>(0);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [secTab, setSecTab] = useState<SecTab>("auth");

  /* ── Live Security State ── */
  const [secDash,       setSecDash]       = useState<SecurityDashboard | null>(null);
  const [lockouts,      setLockouts]      = useState<LockoutEntry[]>([]);
  const [blockedIPsList,setBlockedIPsList] = useState<string[]>([]);
  const [secEvents,     setSecEvents]     = useState<SecurityEvent[]>([]);
  const [newBlockIP,    setNewBlockIP]    = useState("");
  const [liveLoading,   setLiveLoading]  = useState(false);
  const [ipWhitelistError, setIpWhitelistError] = useState<string | null>(null);

  /* ── MFA / TOTP State ── */
  const [mfaStatus,    setMfaStatus]    = useState<MfaStatus | null>(null);
  const [mfaSetupData, setMfaSetupData] = useState<MfaSetupData | null>(null);
  const [mfaToken,     setMfaToken]     = useState("");
  const [disableToken, setDisableToken] = useState("");
  const [mfaLoading,   setMfaLoading]  = useState(false);

  /* ── Data Exports tab state ── */
  const [dataExports,      setDataExports]      = useState<DataExportLog[]>([]);
  const [dataExportsTotal, setDataExportsTotal]  = useState(0);
  const [dataExportsLoading, setDataExportsLoading] = useState(false);
  const [dataExportsPage,  setDataExportsPage]  = useState(0);
  const DATA_EXPORTS_PAGE_SIZE = 20;
  const [suspiciousEvents, setSuspiciousEvents]  = useState<SecurityEvent[]>([]);

  /* ── Token Audit tab state ── */
  const [tokenAuditEvents,  setTokenAuditEvents]  = useState<TokenAuditEvent[]>([]);
  const [tokenAuditTotal,   setTokenAuditTotal]   = useState(0);
  const [tokenAuditLoading, setTokenAuditLoading] = useState(false);
  const [tokenAuditPage,    setTokenAuditPage]    = useState(0);
  const [tokenAuditSearch,  setTokenAuditSearch]  = useState("");
  const [tokenAuditReason,  setTokenAuditReason]  = useState("");
  const TOKEN_AUDIT_PAGE_SIZE = 30;

  /* ── Load platform settings ── */
  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch("/platform-settings");
      const vals: Record<string, string> = {};
      for (const s of (data.settings || [])) vals[s.key] = s.value;
      setLocalValues(vals);
      setSavedValues(vals);
      setDirtyKeys(new Set());
      setIpWhitelistError(null);
      setLastUpdatedAt(Date.now());
    } catch (e: unknown) {
      toast({ title: "Failed to load settings", description: (e as Error).message, variant: "destructive" });
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  /* ── Load live data (lockouts, blocked IPs, events, dashboard) ── */
  const fetchLiveData = useCallback(async () => {
    setLiveLoading(true);
    try {
      const [dash, lockoutData, ipsData, eventsData] = await Promise.all([
        fetchAdminAbsolute(`/api/admin/security-dashboard`),
        fetchAdminAbsolute(`/api/admin/login-lockouts`),
        fetchAdminAbsolute(`/api/admin/blocked-ips`),
        fetchAdminAbsolute(`/api/admin/security-events?limit=30`),
      ]);
      setSecDash(dash);
      setLockouts(lockoutData.lockouts ?? []);
      setBlockedIPsList(ipsData.blocked ?? []);
      setSecEvents(eventsData.events ?? []);
    } catch (e: unknown) {
      toast({ title: "Failed to load live data", description: (e as Error).message, variant: "destructive" });
    }
    setLiveLoading(false);
  }, [toast]);

  /* ── Load MFA status ── */
  const fetchMfaStatus = useCallback(async () => {
    try {
      const data = await fetchAdminAbsolute(`/api/admin/mfa/status`);
      setMfaStatus(data);
    } catch (err) {
      toast({ title: "Could not load MFA status", description: "Auth settings may be unavailable.", variant: "destructive" });
    }
  }, [toast]);

  /* ── Load data exports and suspicious pattern events ── */
  const fetchDataExports = useCallback(async (page = 0) => {
    setDataExportsLoading(true);
    const offset = page * DATA_EXPORTS_PAGE_SIZE;
    try {
      const [exportsData, eventsData] = await Promise.all([
        fetchAdminAbsolute(`/api/admin/security/data-exports?limit=${DATA_EXPORTS_PAGE_SIZE}&offset=${offset}`),
        fetchAdminAbsolute(`/api/admin/security-events?limit=50&type=suspicious_pattern`),
      ]);
      setDataExports(exportsData.exports ?? []);
      setDataExportsTotal(exportsData.total ?? 0);
      setSuspiciousEvents((eventsData.events ?? []).filter((e: SecurityEvent) => e.type === "suspicious_pattern"));
    } catch (e: unknown) {
      toast({ title: "Failed to load data exports", description: (e as Error).message, variant: "destructive" });
    }
    setDataExportsLoading(false);
  }, [toast, DATA_EXPORTS_PAGE_SIZE]);

  /* ── Load token audit events ── */
  const fetchTokenAudit = useCallback(async (page = 0, userId = "", reason = "") => {
    setTokenAuditLoading(true);
    const offset = page * TOKEN_AUDIT_PAGE_SIZE;
    const params = new URLSearchParams({
      limit:  String(TOKEN_AUDIT_PAGE_SIZE),
      offset: String(offset),
    });
    if (userId.trim()) params.set("userId", userId.trim());
    if (reason.trim()) params.set("reason", reason.trim());
    try {
      const data = await fetchAdminAbsolute(`/api/admin/security/token-audit?${params.toString()}`);
      setTokenAuditEvents(data.events ?? []);
      setTokenAuditTotal(data.total ?? 0);
    } catch (e: unknown) {
      toast({ title: "Failed to load token audit log", description: (e as Error).message, variant: "destructive" });
    }
    setTokenAuditLoading(false);
  }, [toast, TOKEN_AUDIT_PAGE_SIZE]);

  /* ── Auto-load live data when switching to auth or fraud tabs ── */
  useEffect(() => {
    if (secTab === "auth" || secTab === "fraud") fetchLiveData();
    if (secTab === "auth") fetchMfaStatus();
    if (secTab === "dataexports") fetchDataExports();
    if (secTab === "tokenaudit") fetchTokenAudit(0, tokenAuditSearch, tokenAuditReason);
  }, [secTab, fetchLiveData, fetchMfaStatus, fetchDataExports, fetchTokenAudit]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Platform settings handlers ── */
  const handleChange = (key: string, value: string) => {
    setLocalValues(prev => ({ ...prev, [key]: value }));
    setDirtyKeys(prev => {
      const n = new Set(prev);
      if (value === savedValues[key]) { n.delete(key); } else { n.add(key); }
      return n;
    });
  };
  const handleToggle = (key: string, v: boolean) => handleChange(key, v ? "on" : "off");

  const handleSave = async () => {
    if (ipWhitelistError) {
      toast({ title: "Validation Error", description: `IP Whitelist: ${ipWhitelistError}`, variant: "destructive" });
      return;
    }
    const numericBounds: Record<string, { min: number; max: number; label: string }> = {
      security_jwt_rotation_days:   { min: 1,   max: 365,    label: "JWT Rotation Days" },
      security_admin_token_hrs:     { min: 1,   max: 720,    label: "Admin Token Expiry" },
      security_session_days:        { min: 1,   max: 365,    label: "Customer Session Duration" },
      security_rider_token_days:    { min: 1,   max: 365,    label: "Rider Token Expiry" },
      security_max_speed_kmh:       { min: 10,  max: 500,    label: "Max Plausible Speed" },
      security_rate_limit:          { min: 1,   max: 10000,  label: "Customer API Rate Limit" },
      security_rate_rider:          { min: 1,   max: 10000,  label: "Rider API Rate Limit" },
      security_rate_vendor:         { min: 1,   max: 10000,  label: "Vendor API Rate Limit" },
      security_rate_admin:          { min: 1,   max: 10000,  label: "Admin Rate Limit" },
      security_lockout_threshold:   { min: 1,   max: 100,    label: "Lockout Threshold" },
      security_lockout_minutes:     { min: 1,   max: 1440,   label: "Lockout Duration" },
    };
    for (const key of dirtyKeys) {
      const bounds = numericBounds[key];
      if (bounds) {
        const raw = localValues[key] ?? "";
        const num = Number(raw);
        if (raw === "" || isNaN(num) || !Number.isInteger(num) || num < bounds.min || num > bounds.max) {
          toast({ title: "Validation Error", description: `${bounds.label} must be a whole number between ${bounds.min} and ${bounds.max}.`, variant: "destructive" });
          return;
        }
      }
    }
    setSaving(true);
    try {
      const changed = Array.from(dirtyKeys).map(key => ({ key, value: localValues[key] ?? "" }));
      await adminFetch("/platform-settings", { method: "PUT", body: JSON.stringify({ settings: changed }) });
      setSavedValues(prev => {
        const updated = { ...prev };
        for (const c of changed) updated[c.key] = c.value;
        return updated;
      });
      setDirtyKeys(new Set());
      toast({ title: "Security settings saved ✅", description: `${changed.length} change(s) applied instantly.` });
    } catch (e: unknown) {
      toast({ title: "Save failed", description: (e as Error).message, variant: "destructive" });
    }
    setSaving(false);
  };

  /* ── Lockout management ── */
  const unlockPhone = async (phone: string) => {
    try {
      await fetchAdminAbsolute(`/api/admin/login-lockouts/${encodeURIComponent(phone)}`, { method: "DELETE" });
      toast({ title: "Account Unlocked", description: `${phone} has been unlocked.` });
      fetchLiveData();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message || "Failed to unlock account", variant: "destructive" });
    }
  };

  /* ── IP Block management ── */
  const blockIP = async () => {
    const ip = newBlockIP.trim();
    if (!ip) return;
    const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
    const ipv6 = /^[0-9a-fA-F:]+$/.test(ip);
    if (!ipv4 && !ipv6) {
      toast({ title: "Invalid IP", description: "Enter a valid IPv4 or IPv6 address.", variant: "destructive" });
      return;
    }
    try {
      await fetchAdminAbsolute(`/api/admin/blocked-ips`, {
        method: "POST",
        body: JSON.stringify({ ip, reason: "Manual block by admin" }),
      });
      setNewBlockIP("");
      toast({ title: "IP Blocked", description: `${ip} has been blocked.` });
      fetchLiveData();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message || "Failed to block IP", variant: "destructive" });
    }
  };

  const unblockIP = async (ip: string) => {
    try {
      await fetchAdminAbsolute(`/api/admin/blocked-ips/${encodeURIComponent(ip)}`, { method: "DELETE" });
      toast({ title: "IP Unblocked", description: `${ip} has been unblocked.` });
      fetchLiveData();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message || "Failed to unblock IP", variant: "destructive" });
    }
  };

  /* ── MFA management ── */
  const startMfaSetup = async () => {
    setMfaLoading(true);
    try {
      const data = await fetchAdminAbsolute(`/api/admin/mfa/setup`, { method: "POST" });
      if (data.secret) { setMfaSetupData(data); setMfaToken(""); }
      else toast({ title: "Error", description: data.error ?? "Failed to start MFA setup", variant: "destructive" });
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    }
    setMfaLoading(false);
  };

  const verifyMfaToken = async () => {
    if (!mfaToken || mfaToken.length !== 6) {
      toast({ title: "Invalid Code", description: "Enter the 6-digit code from your authenticator app.", variant: "destructive" });
      return;
    }
    setMfaLoading(true);
    try {
      const data = await fetchAdminAbsolute(`/api/admin/mfa/verify`, {
        method: "POST", body: JSON.stringify({ token: mfaToken }),
      });
      if (data.success) {
        toast({ title: "MFA Activated!", description: "Two-factor authentication is now enabled." });
        setMfaSetupData(null); setMfaToken(""); fetchMfaStatus();
      } else {
        toast({ title: "Invalid Code", description: data.error ?? "Wrong TOTP code. Try again.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    }
    setMfaLoading(false);
  };

  const disableMfa = async () => {
    if (!disableToken || disableToken.length !== 6) {
      toast({ title: "Code Required", description: "Enter your 6-digit TOTP code to disable MFA.", variant: "destructive" });
      return;
    }
    setMfaLoading(true);
    try {
      const data = await fetchAdminAbsolute(`/api/admin/mfa/disable`, {
        method: "DELETE", body: JSON.stringify({ token: disableToken }),
      });
      if (data.success) {
        toast({ title: "MFA Disabled", description: "Two-factor authentication has been disabled." });
        setDisableToken(""); fetchMfaStatus();
      } else {
        toast({ title: "Error", description: data.error ?? "Failed to disable MFA", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    }
    setMfaLoading(false);
  };

  /* ── Helpers ── */
  const val   = (k: string, def = "")    => localValues[k] ?? def;
  const dirty = (k: string)              => dirtyKeys.has(k);
  const tog   = (k: string, def = "off") => (localValues[k] ?? def) === "on";

  const isValidOctet = (s: string) => { const n = parseInt(s, 10); return n >= 0 && n <= 255 && String(n) === s; };
  const isValidIPv4 = (s: string) => {
    const parts = s.split(".");
    return parts.length === 4 && parts.every(isValidOctet);
  };
  const isValidIpOrCidr = (entry: string) => {
    if (entry.includes("/")) {
      const [ip, prefix] = entry.split("/");
      const p = parseInt(prefix, 10);
      return isValidIPv4(ip) && !isNaN(p) && p >= 0 && p <= 32 && String(p) === prefix;
    }
    return isValidIPv4(entry);
  };

  const validateIpWhitelist = (raw: string): string | null => {
    if (!raw.trim()) return null;
    const entries = raw.split(",").map(s => s.trim()).filter(Boolean);
    const invalid = entries.filter(e => !isValidIpOrCidr(e));
    if (invalid.length > 0) return `Invalid entr${invalid.length === 1 ? "y" : "ies"}: ${invalid.join(", ")}. Use IPv4 or CIDR format (e.g. 192.168.1.1 or 10.0.0.0/8).`;
    return null;
  };

  const handleIpWhitelistChange = (v: string) => {
    handleChange("security_admin_ip_whitelist", v);
    setIpWhitelistError(validateIpWhitelist(v));
  };

  const T = ({ k, label, sub, danger }: { k: string; label: string; sub?: string; danger?: boolean }) => (
    <Toggle label={label} sub={sub} checked={tog(k, danger ? "off" : "on")}
      onChange={v => handleToggle(k, v)} isDirty={dirty(k)} danger={danger} />
  );
  const N = ({ k, label, suffix, placeholder, hint }: { k: string; label: string; suffix?: string; placeholder?: string; hint?: string }) => (
    <Field label={label} value={val(k)} onChange={v => handleChange(k, v)} isDirty={dirty(k)}
      type="number" suffix={suffix} placeholder={placeholder} hint={hint} />
  );
  const F = ({ k, label, placeholder, mono, hint }: { k: string; label: string; placeholder?: string; mono?: boolean; hint?: string }) => (
    <Field label={label} value={val(k)} onChange={v => handleChange(k, v)} isDirty={dirty(k)} placeholder={placeholder} mono={mono} hint={hint} />
  );
  const S = ({ k, label, placeholder }: { k: string; label: string; placeholder?: string }) => (
    <SecretInput label={label} value={val(k)} onChange={v => handleChange(k, v)} isDirty={dirty(k)} placeholder={placeholder} />
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        icon={Shield}
        title="Security"
        subtitle={dirtyKeys.size > 0 ? `${dirtyKeys.size} unsaved change${dirtyKeys.size > 1 ? "s" : ""}` : "OTP, sessions, rate limits, GPS, fraud detection, IP whitelist, audit log"}
        iconBgClass="bg-red-100"
        iconColorClass="text-red-600"
        actions={
          <div className="flex items-center gap-2">
            <LastUpdated dataUpdatedAt={lastUpdatedAt} onRefresh={loadSettings} isRefreshing={loading} />
            <Button variant="outline" onClick={() => { loadSettings(); toast({ title: "Reloaded" }); }} disabled={loading} className="h-9 rounded-xl gap-2">
              <RefreshCw className="w-4 h-4" /> Reset
            </Button>
            <Button onClick={handleSave} disabled={saving || dirtyKeys.size === 0 || !!ipWhitelistError} className="h-9 rounded-xl gap-2 shadow-sm">
              {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {saving ? "Saving..." : `Save${dirtyKeys.size > 0 ? ` (${dirtyKeys.size})` : ""}`}
            </Button>
          </div>
        }
      />

      {/* Sub-tab bar — horizontally scrollable on mobile */}
      <div className="overflow-x-auto -mx-1 px-1">
        <div className="flex gap-1.5 bg-muted/50 p-1.5 rounded-xl w-max min-w-full">
          {SEC_TABS.map(t => (
            <button key={t.id} onClick={() => setSecTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap flex-shrink-0 transition-all ${secTab === t.id ? `${t.active} text-white shadow-sm` : "text-muted-foreground hover:bg-white"}`}>
              <span>{t.emoji}</span> {t.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground px-1">{SEC_TABS.find(t => t.id === secTab)?.desc}</p>

      {/* ─── Auth & Sessions ─── */}
      {secTab === "auth" && (
        <div className="space-y-4">
          {/* OTP pointer — managed in OTP Control page */}
          <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-violet-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-violet-800">
              OTP suspension and per-user bypass are managed exclusively in <strong>OTP Global Control</strong> (sidebar). No duplicate OTP toggles exist here.
            </p>
          </div>

          <SecPanel title="Multi-Factor Authentication (Policy)" icon={Shield} color="text-indigo-700">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <T k="security_mfa_required" label="Two-Factor Auth for Admin Login" sub="Adds TOTP code requirement at every login" />
              <T k="security_multi_device" label="Allow Multiple Device Logins"    sub="One active session or concurrent devices" />
            </div>
          </SecPanel>

          <SecPanel title="Session & Token Expiry" icon={Lock} color="text-indigo-700">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <N k="security_session_days"     label="Customer Session Expiry" suffix="days" placeholder="30" />
              <N k="security_admin_token_hrs"  label="Admin Token Expiry"      suffix="hrs"  placeholder="24" hint="24 hrs = 1 day" />
              <N k="security_rider_token_days" label="Rider Token Expiry"      suffix="days" placeholder="30" />
            </div>
          </SecPanel>

          <SecPanel title="Login Lockout Policy" icon={Lock} color="text-indigo-700">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800 flex gap-2 mb-3">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>After <strong>Max Attempts</strong> failures, the account is locked for <strong>Lockout Duration</strong>. Applies to customer, rider, and vendor logins.</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <N k="security_login_max_attempts" label="Max Failed Login Attempts" placeholder="5"  hint="Before account lockout" />
              <N k="security_lockout_minutes"    label="Lockout Duration"          suffix="min"     placeholder="30" hint="0 = permanent until admin unlocks" />
            </div>
          </SecPanel>

          {/* ── Live: Locked Accounts ── */}
          <SecPanel title="Live Account Lockouts" icon={Users} color="text-indigo-700">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-muted-foreground">Real-time locked accounts due to failed login / OTP attempts</p>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={fetchLiveData} disabled={liveLoading}>
                <RefreshCw className={`w-3 h-3 ${liveLoading ? "animate-spin" : ""}`} /> Refresh
              </Button>
            </div>
            {liveLoading && lockouts.length === 0 ? (
              <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : lockouts.length === 0 ? (
              <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-xl text-xs text-green-700">
                <CheckCircle2 className="w-4 h-4" /> No accounts currently locked. All clear!
              </div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {lockouts.map(l => (
                  <div key={l.phone} className="flex items-center justify-between p-3 bg-red-50 border border-red-200 rounded-xl">
                    <div>
                      <p className="text-xs font-bold font-mono text-red-800">{l.phone}</p>
                      <p className="text-[10px] text-red-600 mt-0.5">
                        {l.minutesLeft ? `Locked — ${l.minutesLeft} min remaining` : `${l.attempts} failed attempts`}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 text-xs text-green-700 border-green-300 hover:bg-green-50"
                      onClick={() => unlockPhone(l.phone)}>Unlock</Button>
                  </div>
                ))}
              </div>
            )}
          </SecPanel>

          {/* ── MFA Setup & Management ── */}
          <SecPanel title="Admin MFA Setup & Management" icon={ShieldCheck} color="text-indigo-700">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800 flex gap-2 mb-4">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>Set up TOTP-based two-factor authentication for your admin account using Google Authenticator, Authy, or any compatible app.</span>
            </div>

            {/* MFA Active */}
            {mfaStatus?.mfaEnabled ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-300 rounded-xl">
                  <ShieldCheck className="w-5 h-5 text-green-600 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-bold text-green-800">MFA is Active</p>
                    <p className="text-xs text-green-700 mt-0.5">Your admin account is protected with TOTP two-factor authentication.</p>
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2">To disable MFA, enter a valid 6-digit code from your authenticator app:</p>
                  <div className="flex gap-2">
                    <Input
                      value={disableToken}
                      onChange={e => setDisableToken(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="6-digit TOTP code"
                      maxLength={6}
                      className="h-9 text-sm font-mono w-40"
                      onKeyDown={e => e.key === "Enter" && disableMfa()}
                    />
                    <Button size="sm" variant="destructive" onClick={disableMfa} disabled={mfaLoading || disableToken.length !== 6}
                      className="h-9 gap-1.5">
                      {mfaLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                      Disable MFA
                    </Button>
                  </div>
                </div>
              </div>
            ) : mfaSetupData ? (
              /* MFA Setup in progress */
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-5 items-start">
                  <div className="flex-shrink-0 bg-white border-2 border-indigo-200 rounded-xl p-2">
                    <img src={mfaSetupData.qrCodeDataUrl} alt="MFA QR Code" className="w-36 h-36 rounded" />
                  </div>
                  <div className="space-y-2 flex-1">
                    <p className="text-xs font-bold text-foreground">Step 1 — Scan with your authenticator app</p>
                    <p className="text-xs text-muted-foreground">Open Google Authenticator, Authy, or any TOTP app and scan the QR code on the left.</p>
                    <div className="bg-muted/60 rounded-lg p-2">
                      <p className="text-[10px] text-muted-foreground mb-1 font-medium">Manual setup key:</p>
                      <p className="text-xs font-mono font-bold text-foreground break-all">{mfaSetupData.secret}</p>
                    </div>
                  </div>
                </div>
                <div>
                  <p className="text-xs font-bold text-foreground mb-2">Step 2 — Enter the 6-digit code to verify and activate:</p>
                  <div className="flex gap-2">
                    <Input
                      value={mfaToken}
                      onChange={e => setMfaToken(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="000000"
                      maxLength={6}
                      className="h-9 text-sm font-mono w-32 tracking-widest"
                      onKeyDown={e => e.key === "Enter" && verifyMfaToken()}
                    />
                    <Button size="sm" onClick={verifyMfaToken} disabled={mfaLoading || mfaToken.length !== 6}
                      className="h-9 bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5">
                      {mfaLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                      Verify & Activate
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => { setMfaSetupData(null); setMfaToken(""); }} className="h-9">
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              /* MFA not set up */
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                  <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-bold text-amber-800">MFA Not Configured</p>
                    <p className="text-xs text-amber-700 mt-0.5">Your admin account does not have two-factor authentication. Set it up for stronger security.</p>
                  </div>
                </div>
                <Button size="sm" onClick={startMfaSetup} disabled={mfaLoading}
                  className="h-9 bg-indigo-600 hover:bg-indigo-700 text-white gap-2">
                  {mfaLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                  Set Up MFA (TOTP)
                </Button>
              </div>
            )}
          </SecPanel>
        </div>
      )}

      {/* ─── Auth Methods (per-role) ─── */}
      {secTab === "authmethods" && (
        <div className="space-y-4">
          <div className="bg-cyan-50 border border-cyan-200 rounded-xl p-3 text-xs text-cyan-800 flex gap-2 mb-1">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              Each auth method can be enabled or disabled per role (Customer, Rider, Vendor).
              Values are stored as JSON: <code className="font-mono bg-white/60 px-1 rounded">{`{"customer":"on","rider":"on","vendor":"off"}`}</code>.
              Changes take effect immediately for all apps.
            </span>
          </div>

          {(() => {
            const ROLE_AUTH_KEYS: { key: string; label: string; sub: string }[] = [
              { key: "auth_phone_otp_enabled",         label: "Phone OTP Login",          sub: "Send OTP via SMS to verify phone number" },
              { key: "auth_email_otp_enabled",         label: "Email OTP Login",          sub: "Send OTP via email to verify address" },
              { key: "auth_username_password_enabled", label: "Username / Password Login", sub: "Traditional username + password credentials" },
              { key: "auth_email_register_enabled",    label: "Email Registration",       sub: "Allow sign-up with email (no phone OTP)" },
              { key: "auth_magic_link_enabled",        label: "Magic Link Login",         sub: "Send one-click login link via email" },
              { key: "auth_2fa_enabled",               label: "Two-Factor Auth (TOTP)",   sub: "Require authenticator app code after login" },
              { key: "auth_biometric_enabled",         label: "Biometric Login",          sub: "Fingerprint / Face ID on mobile devices" },
            ];
            const ROLES = ["customer", "rider", "vendor"] as const;
            const ROLE_LABELS: Record<string, string> = { customer: "Customer", rider: "Rider", vendor: "Vendor" };
            const ROLE_COLORS: Record<string, { on: string; off: string; bg: string }> = {
              customer: { on: "bg-blue-500",   off: "bg-gray-300", bg: "text-blue-700"  },
              rider:    { on: "bg-green-500",  off: "bg-gray-300", bg: "text-green-700" },
              vendor:   { on: "bg-orange-500", off: "bg-gray-300", bg: "text-orange-700" },
            };

            function parseRoleVal(raw: string | undefined, def: string): Record<string, boolean> {
              if (!raw) return { customer: def === "on", rider: def === "on", vendor: def === "on" };
              try {
                const parsed = JSON.parse(raw) as Record<string, string>;
                return { customer: parsed.customer === "on", rider: parsed.rider === "on", vendor: parsed.vendor === "on" };
              } catch {
                return { customer: raw === "on", rider: raw === "on", vendor: raw === "on" };
              }
            }

            function toggleRole(settingKey: string, role: string, current: Record<string, boolean>) {
              const updated = { ...current, [role]: !current[role] };
              handleChange(settingKey, JSON.stringify({
                customer: updated.customer ? "on" : "off",
                rider:    updated.rider    ? "on" : "off",
                vendor:   updated.vendor   ? "on" : "off",
              }));
            }

            return (
              <SecPanel title="Login Methods (Per Role)" icon={KeyRound} color="text-cyan-700">
                <div className="space-y-3">
                  {ROLE_AUTH_KEYS.map(({ key, label, sub }) => {
                    const def = key.includes("2fa") || key.includes("biometric") || key.includes("magic_link") ? "off" : "on";
                    const roles = parseRoleVal(localValues[key], def);
                    const isDirty = dirtyKeys.has(key);
                    return (
                      <div key={key} className={`p-3.5 rounded-xl border transition-all ${isDirty ? "ring-2 ring-amber-300 border-amber-200 bg-amber-50/30" : "border-border bg-white hover:bg-muted/20"}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-foreground leading-snug">{label}</p>
                            <p className="text-xs text-muted-foreground">{sub}</p>
                          </div>
                          {isDirty && <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 font-bold flex-shrink-0 ml-2">CHANGED</Badge>}
                        </div>
                        <div className="flex gap-2">
                          {ROLES.map(role => {
                            const on = roles[role];
                            const colors = ROLE_COLORS[role];
                            return (
                              <button key={role} onClick={() => toggleRole(key, role, roles)}
                                className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-bold transition-all border ${
                                  on ? `${colors.bg} bg-opacity-10 border-current` : "text-gray-400 bg-gray-50 border-gray-200"
                                }`}>
                                <div className={`w-3 h-3 rounded-full ${on ? colors.on : colors.off}`} />
                                {ROLE_LABELS[role]}
                                <span className="text-[10px] font-bold">{on ? "ON" : "OFF"}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </SecPanel>
            );
          })()}

          <SecPanel title="Social Login (Global)" icon={Globe} color="text-cyan-700">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800 flex gap-2 mb-3">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>Social logins require Client ID / App ID configured below. Per-role toggles above control availability.</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <Toggle label="Google Login (legacy)" sub="Global on/off for Google Sign-In" checked={tog("auth_social_google")}
                onChange={v => handleToggle("auth_social_google", v)} isDirty={dirty("auth_social_google")} />
              <Toggle label="Facebook Login (legacy)" sub="Global on/off for Facebook Login" checked={tog("auth_social_facebook")}
                onChange={v => handleToggle("auth_social_facebook", v)} isDirty={dirty("auth_social_facebook")} />
            </div>

            {(() => {
              const GLOBAL_AUTH_KEYS: { key: string; label: string; sub: string }[] = [
                { key: "auth_google_enabled",   label: "Google Login (per-role)",   sub: "Per-role control for Google Sign-In" },
                { key: "auth_facebook_enabled", label: "Facebook Login (per-role)", sub: "Per-role control for Facebook Login" },
              ];
              const ROLES = ["customer", "rider", "vendor"] as const;
              const ROLE_LABELS: Record<string, string> = { customer: "Customer", rider: "Rider", vendor: "Vendor" };
              const ROLE_COLORS: Record<string, { on: string; off: string; bg: string }> = {
                customer: { on: "bg-blue-500",   off: "bg-gray-300", bg: "text-blue-700"  },
                rider:    { on: "bg-green-500",  off: "bg-gray-300", bg: "text-green-700" },
                vendor:   { on: "bg-orange-500", off: "bg-gray-300", bg: "text-orange-700" },
              };
              function parseRoleValLocal(raw: string | undefined): Record<string, boolean> {
                if (!raw) return { customer: false, rider: false, vendor: false };
                try {
                  const parsed = JSON.parse(raw) as Record<string, string>;
                  return { customer: parsed.customer === "on", rider: parsed.rider === "on", vendor: parsed.vendor === "on" };
                } catch { return { customer: raw === "on", rider: raw === "on", vendor: raw === "on" }; }
              }
              function toggleRoleLocal(settingKey: string, role: string, current: Record<string, boolean>) {
                const updated = { ...current, [role]: !current[role] };
                handleChange(settingKey, JSON.stringify({
                  customer: updated.customer ? "on" : "off",
                  rider:    updated.rider    ? "on" : "off",
                  vendor:   updated.vendor   ? "on" : "off",
                }));
              }
              return (
                <div className="space-y-3">
                  {GLOBAL_AUTH_KEYS.map(({ key, label, sub }) => {
                    const roles = parseRoleValLocal(localValues[key]);
                    const isDirtyK = dirtyKeys.has(key);
                    return (
                      <div key={key} className={`p-3.5 rounded-xl border transition-all ${isDirtyK ? "ring-2 ring-amber-300 border-amber-200 bg-amber-50/30" : "border-border bg-white hover:bg-muted/20"}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div><p className="text-sm font-semibold text-foreground">{label}</p><p className="text-xs text-muted-foreground">{sub}</p></div>
                          {isDirtyK && <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 font-bold">CHANGED</Badge>}
                        </div>
                        <div className="flex gap-2">
                          {ROLES.map(role => {
                            const on = roles[role]; const colors = ROLE_COLORS[role];
                            return (
                              <button key={role} onClick={() => toggleRoleLocal(key, role, roles)}
                                className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-bold transition-all border ${on ? `${colors.bg} bg-opacity-10 border-current` : "text-gray-400 bg-gray-50 border-gray-200"}`}>
                                <div className={`w-3 h-3 rounded-full ${on ? colors.on : colors.off}`} />
                                {ROLE_LABELS[role]}
                                <span className="text-[10px] font-bold">{on ? "ON" : "OFF"}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </SecPanel>

          <SecPanel title="Captcha & API Keys" icon={Shield} color="text-cyan-700">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <Toggle label="reCAPTCHA v3 Verification" sub="Require captcha on login / register / OTP" checked={tog("auth_captcha_enabled")}
                onChange={v => handleToggle("auth_captcha_enabled", v)} isDirty={dirty("auth_captcha_enabled")} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <SecretInput label="reCAPTCHA Site Key" value={val("recaptcha_site_key")} onChange={v => handleChange("recaptcha_site_key", v)}
                isDirty={dirty("recaptcha_site_key")} placeholder="6Lc..." />
              <SecretInput label="reCAPTCHA Secret Key" value={val("recaptcha_secret_key")} onChange={v => handleChange("recaptcha_secret_key", v)}
                isDirty={dirty("recaptcha_secret_key")} placeholder="6Lc..." />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
              <SecretInput label="Google Client ID" value={val("google_client_id")} onChange={v => handleChange("google_client_id", v)}
                isDirty={dirty("google_client_id")} placeholder="xxxx.apps.googleusercontent.com" />
              <SecretInput label="Facebook App ID" value={val("facebook_app_id")} onChange={v => handleChange("facebook_app_id", v)}
                isDirty={dirty("facebook_app_id")} placeholder="123456789" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
              <Field label="reCAPTCHA Min Score" value={val("recaptcha_min_score", "0.5")} onChange={v => handleChange("recaptcha_min_score", v)}
                isDirty={dirty("recaptcha_min_score")} type="number" placeholder="0.5" hint="0.0 to 1.0 (higher = stricter)" />
              <Field label="OTP Resend Cooldown" value={val("security_otp_cooldown_sec", "60")} onChange={v => handleChange("security_otp_cooldown_sec", v)}
                isDirty={dirty("security_otp_cooldown_sec")} type="number" suffix="sec" placeholder="60" hint="Seconds between OTP resends" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
              <Field label="Trusted Device Expiry" value={val("auth_trusted_device_days", "30")} onChange={v => handleChange("auth_trusted_device_days", v)}
                isDirty={dirty("auth_trusted_device_days")} type="number" suffix="days" placeholder="30" hint="Skip 2FA on trusted devices" />
            </div>
          </SecPanel>
        </div>
      )}

      {/* ─── Rate Limiting ─── */}
      {secTab === "ratelimit" && (
        <div className="space-y-4">
          <SecPanel title="Per-Role API Rate Limits" icon={Zap} color="text-blue-700">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800 flex gap-2 mb-3">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>Limits are per IP address per minute. Exceeding triggers HTTP 429 Too Many Requests. Burst allowance temporarily permits extra requests during short spikes.</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <N k="security_rate_limit"  label="General API (customers)" suffix="req/min" placeholder="100" />
              <N k="security_rate_admin"  label="Admin Panel"             suffix="req/min" placeholder="60" />
              <N k="security_rate_rider"  label="Rider App API"           suffix="req/min" placeholder="200" />
              <N k="security_rate_vendor" label="Vendor App API"          suffix="req/min" placeholder="150" />
              <N k="security_rate_burst"  label="Burst Allowance"         suffix="req"     placeholder="20" hint="Extra requests before block" />
            </div>
          </SecPanel>

          <SecPanel title="IP-Level Blocking" icon={Shield} color="text-blue-700">
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800 flex gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span><strong>Warning:</strong> VPN blocking may affect legitimate users. TOR blocking prevents anonymous access. Use carefully in Pakistan — some users may use VPNs for privacy.</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <T k="security_block_tor" label="Block TOR Exit Nodes"  sub="Prevents anonymous TOR access" />
              <T k="security_block_vpn" label="Block VPN/Proxy Users" sub="Fraud prevention (may affect legit users)" />
            </div>
          </SecPanel>

          <div className="rounded-2xl border border-border bg-muted/20 p-5">
            <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <BarChart3 className="w-3.5 h-3.5" /> Current Rate Limit Overview
            </p>
            <div className="space-y-2">
              {[
                { label: "Customer API", key: "security_rate_limit",  color: "bg-green-500",  def: "100" },
                { label: "Rider API",    key: "security_rate_rider",  color: "bg-blue-500",   def: "200" },
                { label: "Vendor API",   key: "security_rate_vendor", color: "bg-orange-500", def: "150" },
                { label: "Admin Panel",  key: "security_rate_admin",  color: "bg-purple-500", def: "60"  },
              ].map(({ label, key, color, def }) => {
                const v = parseInt(val(key, def)) || parseInt(def);
                const pct = Math.min(100, (v / 300) * 100);
                return (
                  <div key={key} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-24 flex-shrink-0">{label}</span>
                    <div className="flex-1 bg-muted rounded-full h-2">
                      <div className={`h-2 rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs font-bold text-foreground w-16 text-right">{v} req/min</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── GPS & Location ─── */}
      {secTab === "gps" && (
        <div className="space-y-4">
          <SecPanel title="GPS Tracking" icon={Bike} color="text-green-700">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <T k="security_gps_tracking"    label="Enable GPS Tracking"    sub="Rider location updates sent to server" />
              <T k="security_spoof_detection" label="GPS Spoofing Detection" sub="Mock location / fake GPS app detection" />
              <T k="security_geo_fence"       label="Strict Geofence Mode"   sub="Riders must be within service area" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <N k="security_gps_accuracy"  label="Min GPS Accuracy Required" suffix="m"    placeholder="50"  hint="Reject readings worse than this" />
              <N k="security_gps_interval"  label="Location Update Interval"  suffix="sec"  placeholder="10"  hint="How often rider sends GPS ping" />
              <N k="security_max_speed_kmh" label="Max Plausible Speed"       suffix="km/h" placeholder="150" hint="Above this = flag as suspicious" />
            </div>
          </SecPanel>

          <SecPanel title="Service Area & Coverage" icon={Globe} color="text-green-700">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800 flex gap-2">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>Service area boundaries are controlled per city in the Geofence settings. When Strict Mode is on, orders outside the defined zones are automatically rejected.</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
              <F k="security_service_city"      label="Primary Service City"    placeholder="Muzaffarabad, AJK" />
              <F k="security_service_radius_km" label="Max Service Radius (km)" placeholder="30" mono hint="From city center" />
            </div>
          </SecPanel>

          <div className="rounded-2xl border border-green-200 bg-green-50 p-4 text-xs text-green-800 space-y-1">
            <p className="font-bold flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> GPS Spoofing Detection checks for:</p>
            <ul className="list-disc list-inside space-y-0.5 ml-1 text-green-700">
              <li>Mock location apps (Developer Options enabled)</li>
              <li>Location jumping more than {val("security_max_speed_kmh", "150")} km/h between pings</li>
              <li>Accuracy worse than {val("security_gps_accuracy", "50")}m reported by device</li>
              <li>GPS coordinates matching known VPN/proxy datacenter locations</li>
            </ul>
          </div>
        </div>
      )}

      {/* ─── Password & Token Policy ─── */}
      {secTab === "passwords" && (
        <div className="space-y-4">
          <SecPanel title="Password Requirements" icon={KeyRound} color="text-amber-700">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3">
              <N k="security_pwd_min_length"  label="Minimum Length"  suffix="chars" placeholder="8" />
              <N k="security_pwd_expiry_days" label="Password Expiry" suffix="days"  placeholder="0" hint="0 = never expires" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <T k="security_pwd_strong" label="Require Strong Password" sub="Must include uppercase, number & symbol" />
            </div>
            <div className="mt-4 bg-muted/50 rounded-xl p-3 border border-border">
              <p className="text-xs font-semibold text-foreground mb-2">Current Password Rules Preview:</p>
              <div className="space-y-1">
                {[
                  { ok: parseInt(val("security_pwd_min_length", "8")) >= 8, label: `At least ${val("security_pwd_min_length", "8")} characters` },
                  { ok: tog("security_pwd_strong", "on"), label: "Uppercase letter required (A-Z)" },
                  { ok: tog("security_pwd_strong", "on"), label: "Number required (0-9)" },
                  { ok: tog("security_pwd_strong", "on"), label: "Special character required (!@#$...)" },
                ].map(({ ok, label }) => (
                  <div key={label} className="flex items-center gap-2 text-xs">
                    {ok ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> : <XCircle className="w-3.5 h-3.5 text-muted-foreground" />}
                    <span className={ok ? "text-foreground" : "text-muted-foreground"}>{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </SecPanel>

          <SecPanel title="JWT & API Token Settings" icon={KeyRound} color="text-amber-700">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800 flex gap-2 mb-3">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>JWT Secret is auto-generated and stored securely. Rotation invalidates all existing sessions — users must log in again.</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <N k="security_jwt_rotation_days" label="JWT Secret Rotation" suffix="days" placeholder="90" hint="All sessions invalidated on rotation" />
              <N k="security_admin_token_hrs"   label="Admin Token Expiry"  suffix="hrs"  placeholder="24" />
              <N k="security_session_days"      label="Customer Session"     suffix="days" placeholder="30" />
              <N k="security_rider_token_days"  label="Rider Token Expiry"  suffix="days" placeholder="30" />
            </div>
          </SecPanel>
        </div>
      )}

      {/* ─── File Uploads ─── */}
      {secTab === "uploads" && (
        <div className="space-y-4">
          <SecPanel title="Upload Permissions" icon={FileText} color="text-teal-700">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <T k="security_allow_uploads"   label="Allow File Uploads"   sub="Photos, payment proofs, KYC docs" />
              <T k="security_compress_images" label="Auto-compress Images" sub="Reduces storage & bandwidth usage" />
              <T k="security_scan_uploads"    label="Virus/Malware Scan"   sub="Scan uploads before saving (requires ClamAV)" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <N k="security_max_file_mb" label="Max File Size"       suffix="MB" placeholder="5"  hint="Per upload" />
              <N k="security_img_quality" label="Compression Quality" suffix="%"  placeholder="80" hint="80% = good balance" />
            </div>
          </SecPanel>

          <SecPanel title="Allowed File Types" icon={FileText} color="text-teal-700">
            <F k="security_allowed_types" label="Allowed Extensions (comma-separated)" placeholder="jpg,jpeg,png,pdf"
              mono hint="Reject all other file types at the upload API layer" />
            <div className="flex flex-wrap gap-1.5 mt-2">
              {val("security_allowed_types", "jpg,jpeg,png,pdf").split(",").map(t => t.trim()).filter(Boolean).map(ext => (
                <span key={ext} className="px-2 py-0.5 bg-teal-100 text-teal-700 rounded-full text-xs font-bold uppercase">{ext}</span>
              ))}
            </div>
          </SecPanel>

          <SecPanel title="Upload Use Cases" icon={CheckCircle2} color="text-teal-700">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { k: "upload_payment_proof", label: "Payment Proof Screenshots", sub: "JazzCash / EasyPaisa receipts" },
                { k: "upload_kyc_docs",      label: "KYC Identity Documents",    sub: "CNIC photos for wallet KYC" },
                { k: "upload_rider_docs",    label: "Rider CNIC & License",      sub: "Registration documents" },
                { k: "upload_vendor_docs",   label: "Vendor Business Docs",      sub: "Shop license / registration" },
                { k: "upload_product_imgs",  label: "Product/Menu Images",       sub: "Vendor product photos" },
                { k: "upload_cod_proof",     label: "COD Cash Photo Proof",      sub: "High-value COD orders" },
              ].map(({ k, label, sub }) => (
                <Toggle key={k} label={label} sub={sub} checked={(localValues[k] ?? "on") === "on"}
                  onChange={v => handleToggle(k, v)} isDirty={dirty(k)} />
              ))}
            </div>
          </SecPanel>
        </div>
      )}

      {/* ─── Fraud Detection ─── */}
      {secTab === "fraud" && (
        <div className="space-y-4">
          <SecPanel title="Fake Order Prevention" icon={AlertTriangle} color="text-red-700">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <T k="security_fake_order_detect" label="Fake Order Auto-Detection"   sub="Flag suspicious order patterns" />
              <T k="security_auto_block_ip"     label="Auto-block Suspicious IPs"   sub="After repeated fake orders" />
              <T k="security_phone_verify"      label="Phone Verification Required" sub="Before placing first order" />
              <T k="security_single_phone"      label="One Account per Phone"       sub="Prevent multi-account fraud" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <N k="security_max_daily_orders" label="Max Orders per Day"         placeholder="20" hint="Per customer account" />
              <N k="security_new_acct_limit"   label="New Account Order Limit"   placeholder="3"  hint="First 7 days after signup" />
              <N k="security_same_addr_limit"  label="Same-Address Hourly Limit" placeholder="5"  hint="Orders from same address per hour" />
            </div>
          </SecPanel>

          {/* Fraud Risk Score Info */}
          <SecPanel title="Fraud Risk Signals" icon={Shield} color="text-red-700">
            <div className="bg-muted/50 rounded-xl p-4 border border-border">
              <p className="text-xs font-semibold text-foreground mb-3">Risk signals the system monitors:</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[
                  { label: "Multiple orders cancelled without payment",   risk: "HIGH" },
                  { label: "COD orders placed & rejected repeatedly",     risk: "HIGH" },
                  { label: "Same phone number on multiple accounts",      risk: "MED" },
                  { label: "Orders placed from known VPN/proxy IPs",      risk: "MED" },
                  { label: "GPS location changing across cities rapidly",  risk: "MED" },
                  { label: "New account placing high-value orders day 1", risk: "LOW" },
                ].map(({ label, risk }) => (
                  <div key={label} className="flex items-start gap-2 text-xs">
                    <span className={`px-1.5 py-0.5 rounded font-bold flex-shrink-0 text-[10px] ${
                      risk === "HIGH" ? "bg-red-100 text-red-700" : risk === "MED" ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"
                    }`}>{risk}</span>
                    <span className="text-muted-foreground">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </SecPanel>

          {/* ── Live: IP Block Manager ── */}
          <SecPanel title="Live IP Block Manager" icon={Shield} color="text-red-700">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-muted-foreground">Manually block or unblock IP addresses in real-time</p>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={fetchLiveData} disabled={liveLoading}>
                <RefreshCw className={`w-3 h-3 ${liveLoading ? "animate-spin" : ""}`} /> Refresh
              </Button>
            </div>
            <div className="flex gap-2 mb-3">
              <Input
                value={newBlockIP}
                onChange={e => setNewBlockIP(e.target.value.trim())}
                placeholder="Enter IP address e.g. 192.168.1.100"
                className="h-8 text-xs font-mono flex-1"
                onKeyDown={e => e.key === "Enter" && blockIP()}
              />
              <Button size="sm" className="h-8 text-xs bg-red-600 hover:bg-red-700 text-white" onClick={blockIP} disabled={!newBlockIP.trim()}>
                Block IP
              </Button>
            </div>
            {liveLoading && blockedIPsList.length === 0 ? (
              <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : blockedIPsList.length === 0 ? (
              <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-xl text-xs text-green-700">
                <CheckCircle2 className="w-4 h-4" /> No IPs currently blocked.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-52 overflow-y-auto">
                {blockedIPsList.map(ip => (
                  <div key={ip} className="flex items-center justify-between px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                    <span className="text-xs font-mono font-bold text-red-800">{ip}</span>
                    <Button size="sm" variant="ghost" className="h-6 text-xs text-green-700 hover:text-green-800"
                      onClick={() => unblockIP(ip)}>Unblock</Button>
                  </div>
                ))}
              </div>
            )}
          </SecPanel>

          {/* ── Recent Security Events ── */}
          <SecPanel title="Recent Security Events" icon={AlertTriangle} color="text-red-700">
            {secEvents.length === 0 ? (
              <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-xl text-xs text-green-700">
                <CheckCircle2 className="w-4 h-4" /> No security events recorded. All clear!
              </div>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto">
                {secEvents.slice(0, 20).map((e, i) => (
                  <div key={i} className={`flex items-start gap-2 p-2 rounded-lg text-xs border ${
                    e.severity === "critical" ? "bg-red-50 border-red-200" :
                    e.severity === "high"     ? "bg-orange-50 border-orange-200" :
                    e.severity === "medium"   ? "bg-amber-50 border-amber-200" :
                    "bg-gray-50 border-gray-200"
                  }`}>
                    <span className={`px-1.5 py-0.5 rounded font-bold text-[9px] flex-shrink-0 mt-0.5 uppercase ${
                      e.severity === "critical" ? "bg-red-600 text-white" :
                      e.severity === "high"     ? "bg-orange-500 text-white" :
                      e.severity === "medium"   ? "bg-amber-500 text-white" :
                      "bg-gray-400 text-white"
                    }`}>{e.severity}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-foreground truncate">{e.type.replace(/_/g, " ")}</p>
                      <p className="text-muted-foreground truncate">{e.details}</p>
                      <p className="text-[10px] text-muted-foreground/70">{new Date(e.timestamp).toLocaleString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SecPanel>

          {/* Admin Access & Audit Log settings */}
          <SecPanel title="Admin Access & Audit Log" icon={Shield} color="text-red-700">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <T k="security_audit_log"    label="Admin Action Audit Log" sub="Log all admin changes with timestamp & IP" />
              <T k="security_mfa_required" label="Require 2FA for Admin"  sub="TOTP code required at every login" />
            </div>
            <Field
              label="Admin IP Whitelist (comma-separated, blank = allow all)"
              value={val("security_admin_ip_whitelist")}
              onChange={handleIpWhitelistChange}
              isDirty={dirty("security_admin_ip_whitelist")}
              placeholder="103.25.0.1, 123.123.123.123"
              mono
              hint="Only these IPs can access the admin panel. Leave blank for no restriction."
            />
            {ipWhitelistError && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 mt-1">
                <XCircle className="w-4 h-4 flex-shrink-0" />
                <span>{ipWhitelistError}</span>
              </div>
            )}
            {!ipWhitelistError && val("security_admin_ip_whitelist") ? (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {val("security_admin_ip_whitelist").split(",").map(ip => ip.trim()).filter(Boolean).map(ip => (
                  <span key={ip} className="px-2.5 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-mono font-bold">{ip}</span>
                ))}
              </div>
            ) : !ipWhitelistError ? (
              <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700 mt-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>No IP restriction set — admin panel accessible from any IP.</span>
              </div>
            ) : null}
          </SecPanel>

          <SecPanel title="Maintenance Bypass Key" icon={Shield} color="text-red-700">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800 flex gap-2 mb-3">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>Admins can bypass maintenance mode by appending <span className="font-mono bg-white/70 px-1 rounded">?key=YOUR_KEY</span> to the app URL.</span>
            </div>
            <S k="security_maintenance_key" label="Maintenance Mode Bypass Key" placeholder="maint-bypass-secret-2025" />
          </SecPanel>
        </div>
      )}

      {secTab === "dataexports" && (
        <DataExportsTab
          dataExports={dataExports}
          dataExportsTotal={dataExportsTotal}
          dataExportsLoading={dataExportsLoading}
          suspiciousEvents={suspiciousEvents}
          page={dataExportsPage}
          pageSize={DATA_EXPORTS_PAGE_SIZE}
          onPageChange={(p) => { setDataExportsPage(p); fetchDataExports(p); }}
          onRefresh={() => fetchDataExports(dataExportsPage)}
        />
      )}

      {secTab === "tokenaudit" && (
        <TokenAuditTab
          events={tokenAuditEvents}
          total={tokenAuditTotal}
          loading={tokenAuditLoading}
          page={tokenAuditPage}
          pageSize={TOKEN_AUDIT_PAGE_SIZE}
          search={tokenAuditSearch}
          reasonFilter={tokenAuditReason}
          onSearchChange={setTokenAuditSearch}
          onReasonChange={setTokenAuditReason}
          onSearch={() => { setTokenAuditPage(0); fetchTokenAudit(0, tokenAuditSearch, tokenAuditReason); }}
          onPageChange={(p) => { setTokenAuditPage(p); fetchTokenAudit(p, tokenAuditSearch, tokenAuditReason); }}
          onRefresh={() => fetchTokenAudit(tokenAuditPage, tokenAuditSearch, tokenAuditReason)}
        />
      )}

      <div className="bg-blue-50/60 border border-blue-200/60 rounded-xl p-4 flex gap-3">
        <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-blue-700">
          <strong className="text-blue-800">Changes apply instantly</strong> after saving — no restart needed.
        </p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   DATA EXPORTS TAB — GDPR export audit + suspicious
   pattern events
═══════════════════════════════════════════════════════ */
function DataExportsTab({
  dataExports,
  dataExportsTotal,
  dataExportsLoading,
  suspiciousEvents,
  page,
  pageSize,
  onPageChange,
  onRefresh,
}: {
  dataExports: DataExportLog[];
  dataExportsTotal: number;
  dataExportsLoading: boolean;
  suspiciousEvents: SecurityEvent[];
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onRefresh: () => void;
}) {
  const totalPages = Math.max(1, Math.ceil(dataExportsTotal / pageSize));
  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString("en-GB", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return iso; }
  };

  const severityBadge = (sev: string) => {
    const cls: Record<string, string> = {
      critical: "bg-red-100 text-red-700",
      high:     "bg-orange-100 text-orange-700",
      medium:   "bg-yellow-100 text-yellow-700",
      low:      "bg-gray-100 text-gray-600",
    };
    return cls[sev] ?? cls["low"];
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-gray-900">Data Export Audit Log</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Every GDPR data-export request is logged here with user, IP, and outcome.
            {dataExportsTotal > 0 && ` (${dataExportsTotal} total records)`}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onRefresh}
          disabled={dataExportsLoading}
          className="gap-1.5"
        >
          {dataExportsLoading
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </Button>
      </div>

      {/* Export logs table */}
      <div className="rounded-2xl border border-border bg-white overflow-hidden">
        {dataExportsLoading ? (
          <div className="flex items-center justify-center py-16 text-gray-400 gap-2">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading export logs…</span>
          </div>
        ) : dataExports.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400 gap-3">
            <Download className="w-8 h-8 opacity-40" />
            <div className="text-center">
              <p className="text-sm font-medium">No data exports yet</p>
              <p className="text-xs mt-1">Records will appear here when users request their data exports.</p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-gray-50/70">
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">User / Phone</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">IP Address</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Requested At</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Completed At</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {dataExports.map(row => (
                  <tr key={row.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-mono text-gray-700">{row.maskedPhone ?? "—"}</div>
                      {row.userId && (
                        <div className="text-gray-400 text-[10px] mt-0.5 truncate max-w-[140px]">{row.userId}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-600">{row.ip}</td>
                    <td className="px-4 py-3 text-gray-600">{formatDate(row.requestedAt)}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {row.completedAt ? formatDate(row.completedAt) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {row.success ? (
                        <Badge className="bg-green-100 text-green-700 hover:bg-green-100 text-[10px]">
                          <CheckCircle2 className="w-3 h-3 mr-1" />Success
                        </Badge>
                      ) : (
                        <Badge className="bg-red-100 text-red-600 hover:bg-red-100 text-[10px]">
                          <XCircle className="w-3 h-3 mr-1" />Failed
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Pagination controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50/50">
                <span className="text-xs text-gray-500">
                  Page {page + 1} of {totalPages} &middot; {dataExportsTotal} total record{dataExportsTotal !== 1 ? "s" : ""}
                </span>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPageChange(page - 1)}
                    disabled={page === 0 || dataExportsLoading}
                    className="h-7 px-2 text-xs"
                  >
                    ← Prev
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPageChange(page + 1)}
                    disabled={page >= totalPages - 1 || dataExportsLoading}
                    className="h-7 px-2 text-xs"
                  >
                    Next →
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Suspicious pattern events */}
      <div className="rounded-2xl border border-border bg-white overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border bg-orange-50/50">
          <AlertTriangle className="w-4 h-4 text-orange-600" />
          <h4 className="text-sm font-bold text-orange-800">Suspicious API Pattern Events</h4>
          {suspiciousEvents.length > 0 && (
            <Badge className="bg-orange-200 text-orange-800 hover:bg-orange-200 text-[10px] ml-auto">
              {suspiciousEvents.length} event{suspiciousEvents.length !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>

        {suspiciousEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-3">
            <ShieldCheck className="w-7 h-7 opacity-40" />
            <div className="text-center">
              <p className="text-sm font-medium">No suspicious patterns detected</p>
              <p className="text-xs mt-1">
                Events appear here when an IP exceeds the rate threshold on sensitive endpoints.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-gray-50/70">
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Severity</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Details</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {suspiciousEvents.map((ev, i) => (
                  <tr key={i} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <Badge className={`${severityBadge(ev.severity)} hover:${severityBadge(ev.severity)} text-[10px] capitalize`}>
                        {ev.severity}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-700 max-w-xs">
                      <span className="truncate block">{ev.details}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{formatDate(ev.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Sentry Known Issues info card */}
      <div className="rounded-2xl border border-violet-200 bg-violet-50/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Bug className="w-4 h-4 text-violet-600" />
          <h4 className="text-sm font-bold text-violet-800">Sentry Webhook Deduplication</h4>
        </div>
        <p className="text-xs text-violet-700 leading-relaxed">
          When a new Sentry error type (unique fingerprint) arrives at{" "}
          <code className="bg-violet-100 px-1 rounded font-mono text-[10px]">POST /api/admin/sentry-webhook</code>,
          it is recorded in the <code className="bg-violet-100 px-1 rounded font-mono text-[10px]">sentry_known_issues</code> table
          and an admin alert is sent. Subsequent occurrences of the same fingerprint are silently acknowledged.
        </p>
        <div className="flex items-start gap-2 bg-violet-100/70 rounded-xl p-3 text-xs text-violet-700">
          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            To enable: add <strong>SENTRY_WEBHOOK_SECRET</strong> to Replit Secrets, then configure the webhook URL in
            Sentry → Project Settings → Integrations → Webhooks.
          </span>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   TOKEN AUDIT TAB — refresh token rotation trail
   Shows rotations, reuse attempts, family invalidations,
   and other revocation events per user.
═══════════════════════════════════════════════════════ */
const REASON_OPTIONS = [
  { value: "",                          label: "All reasons" },
  { value: "ROTATED",                   label: "Rotated (normal)" },
  { value: "FAMILY_BREACH_DETECTED",    label: "Family breach detected" },
  { value: "SUSPICIOUS_FAMILY_REUSE",   label: "Suspicious family reuse" },
  { value: "REUSE_DETECTED",            label: "Reuse detected" },
  { value: "EXPIRED",                   label: "Expired" },
  { value: "AUTH_METHOD_DISABLED",      label: "Auth method disabled" },
  { value: "USER_UNAVAILABLE",          label: "User unavailable" },
  { value: "ALL_SESSIONS_REVOKED",      label: "All sessions revoked" },
  { value: "UNKNOWN_METHOD",            label: "Unknown method" },
  { value: "REVOKED",                   label: "Generic revoke" },
];

function TokenAuditTab({
  events,
  total,
  loading,
  page,
  pageSize,
  search,
  reasonFilter,
  onSearchChange,
  onReasonChange,
  onSearch,
  onPageChange,
  onRefresh,
}: {
  events: TokenAuditEvent[];
  total: number;
  loading: boolean;
  page: number;
  pageSize: number;
  search: string;
  reasonFilter: string;
  onSearchChange: (v: string) => void;
  onReasonChange: (v: string) => void;
  onSearch: () => void;
  onPageChange: (p: number) => void;
  onRefresh: () => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /* ── Session timeline drawer state (self-contained here) ── */
  const [timelineUserId,    setTimelineUserId]    = useState<string | null>(null);
  const [timelineUserLabel, setTimelineUserLabel] = useState("");

  const openTimeline = (userId: string, label: string) => {
    setTimelineUserId(userId);
    setTimelineUserLabel(label);
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("en-GB", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch { return iso; }
  };

  const eventTypeMeta: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
    rotation: { label: "Rotated",      cls: "bg-blue-100 text-blue-700",      icon: RotateCcw },
    breach:   { label: "Breach",       cls: "bg-red-100 text-red-800",        icon: AlertTriangle },
    reuse:    { label: "Reuse",        cls: "bg-orange-100 text-orange-700",  icon: AlertTriangle },
    security: { label: "Security",     cls: "bg-amber-100 text-amber-700",    icon: ShieldCheck },
    expired:  { label: "Expired",      cls: "bg-gray-100 text-gray-600",      icon: Lock },
    other:    { label: "Other",        cls: "bg-slate-100 text-slate-600",    icon: KeyRound },
  };

  return (
    <div className="space-y-6">
      {/* Session timeline drawer */}
      {timelineUserId && (
        <UserTimelineDrawer
          userId={timelineUserId}
          userLabel={timelineUserLabel}
          onClose={() => setTimelineUserId(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-bold text-gray-900">Token Rotation Audit Trail</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Every refresh token revocation is recorded here — rotations, reuse alerts, session invalidations.
            {total > 0 && ` (${total} total events)`}
            {" "}<span className="text-rose-500 font-medium">Click a user to see their full session timeline.</span>
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onRefresh}
          disabled={loading}
          className="gap-1.5"
        >
          {loading
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex gap-2 flex-wrap">
        <Input
          className="h-8 text-xs w-64 font-mono"
          placeholder="Filter by User ID…"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          onKeyDown={e => e.key === "Enter" && onSearch()}
        />
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-ring"
          value={reasonFilter}
          onChange={e => onReasonChange(e.target.value)}
        >
          {REASON_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <Button size="sm" variant="secondary" className="h-8 text-xs" onClick={onSearch}>
          Search
        </Button>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(eventTypeMeta).map(([key, m]) => (
          <span key={key} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${m.cls}`}>
            <m.icon className="w-3 h-3" />
            {m.label}
          </span>
        ))}
      </div>

      {/* Events table */}
      <div className="rounded-2xl border border-border bg-white overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400 gap-2">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading audit events…</span>
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400 gap-3">
            <RotateCcw className="w-8 h-8 opacity-40" />
            <div className="text-center">
              <p className="text-sm font-medium">No token events found</p>
              <p className="text-xs mt-1">
                {search || reasonFilter
                  ? "Try clearing the filters."
                  : "Rotation events will appear here as users log in and refresh their sessions."}
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-gray-50/70">
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Event</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">User</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Auth Method</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Token Family</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Issued At</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Revoked At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {events.map(ev => {
                  const meta = eventTypeMeta[ev.eventType] ?? eventTypeMeta["other"]!;
                  const Icon = meta.icon;
                  const isBreach = ev.eventType === "breach" || ev.eventType === "reuse";
                  const label = ev.userPhone ?? ev.userName ?? ev.userId;
                  return (
                    <tr
                      key={ev.id}
                      className={`hover:bg-gray-50/60 transition-colors ${isBreach ? "bg-red-50/30" : ""}`}
                    >
                      <td className="px-4 py-3">
                        <Badge className={`${meta.cls} hover:${meta.cls} text-[10px] gap-1`}>
                          <Icon className="w-3 h-3" />
                          {meta.label}
                        </Badge>
                        {ev.revokedReason && (
                          <div className="text-[10px] text-gray-400 mt-0.5 font-mono">{ev.revokedReason}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {/* Clickable user cell — opens timeline drawer */}
                        <button
                          onClick={() => openTimeline(ev.userId, label)}
                          className="text-left group w-full"
                          title="View session timeline"
                        >
                          {ev.userPhone ? (
                            <div className="font-mono text-gray-700 group-hover:text-rose-600 transition-colors flex items-center gap-1">
                              {ev.userPhone}
                              <ChevronRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity text-rose-500" />
                            </div>
                          ) : (
                            <div className="text-gray-400 italic text-[10px]">deleted user</div>
                          )}
                          {ev.userName && (
                            <div className="text-gray-500 text-[10px] mt-0.5">{ev.userName}</div>
                          )}
                          <div className="text-gray-300 text-[10px] font-mono truncate max-w-[120px] group-hover:text-rose-300 transition-colors">
                            {ev.userId}
                          </div>
                        </button>
                      </td>
                      <td className="px-4 py-3 text-gray-600 capitalize">
                        {ev.authMethod ? ev.authMethod.replace(/_/g, " ") : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 font-mono text-gray-500 text-[10px]">
                        {ev.tokenFamilyId
                          ? <span title={ev.tokenFamilyId}>{ev.tokenFamilyId.slice(0, 8)}…</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(ev.issuedAt)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {isBreach ? (
                          <span className="text-red-600 font-semibold">{formatDate(ev.revokedAt)}</span>
                        ) : (
                          <span className="text-gray-500">{formatDate(ev.revokedAt)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50/50">
                <span className="text-xs text-gray-500">
                  Page {page + 1} of {totalPages} &middot; {total} total event{total !== 1 ? "s" : ""}
                </span>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPageChange(page - 1)}
                    disabled={page === 0 || loading}
                    className="h-7 px-2 text-xs"
                  >
                    ← Prev
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPageChange(page + 1)}
                    disabled={page >= totalPages - 1 || loading}
                    className="h-7 px-2 text-xs"
                  >
                    Next →
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Info card */}
      <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600" />
          <h4 className="text-sm font-bold text-rose-800">Reuse & Breach Detection</h4>
        </div>
        <p className="text-xs text-rose-700 leading-relaxed">
          If a <strong>Breach</strong>, <strong>Suspicious family reuse</strong> or <strong>Reuse detected</strong> event
          appears, every token in that family was immediately invalidated — forcing the user to log in again. This
          indicates a refresh token may have been stolen and replayed from a second device.
        </p>
        <div className="flex items-start gap-2 bg-rose-100/70 rounded-xl p-3 text-xs text-rose-700">
          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            Click any user row to open their <strong>full session timeline</strong> — all token families,
            rotation chains, and breach events in one view.
          </span>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   USER TIMELINE DRAWER
   Slide-over panel showing a user's complete login →
   rotation → revocation chain across all token families.
═══════════════════════════════════════════════════════ */
function UserTimelineDrawer({
  userId,
  userLabel,
  onClose,
}: {
  userId: string;
  userLabel: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [timeline, setTimeline]   = useState<UserTimeline | null>(null);
  const [loading,  setLoading]    = useState(true);
  const [error,    setError]      = useState<string | null>(null);

  /* ── Force logout state machine: idle → confirming → loading → done ── */
  type FLState = "idle" | "confirming" | "loading" | "done";
  const [flState,        setFlState]        = useState<FLState>("idle");
  const [flRevokedCount, setFlRevokedCount] = useState(0);

  /* ── Per-family surgical revoke ── */
  type FamRevokeState = "idle" | "confirming" | "loading";
  const [familyRevoke, setFamilyRevoke] = useState<Record<string, FamRevokeState>>({});

  const setFamState = (fid: string, state: FamRevokeState) =>
    setFamilyRevoke(prev => ({ ...prev, [fid]: state }));

  const revokeFamily = async (familyId: string) => {
    setFamState(familyId, "loading");
    try {
      const resp = await fetchAdminAbsolute(
        `/api/admin/security/revoke-family/${encodeURIComponent(userId)}/${encodeURIComponent(familyId)}`,
        { method: "POST" },
      );
      toast({
        title:       "Family revoked",
        description: resp.message ?? `Session family terminated.`,
      });
      setFamilyRevoke(prev => { const next = { ...prev }; delete next[familyId]; return next; });
      fetchTimeline();
    } catch (err: unknown) {
      setFamState(familyId, "idle");
      toast({
        title:       "Revoke failed",
        description: (err as Error).message ?? "An error occurred",
        variant:     "destructive",
      });
    }
  };

  /* ── CSV export ── */
  const [csvLoading, setCsvLoading] = useState(false);

  const downloadCsv = async () => {
    if (csvLoading) return;
    setCsvLoading(true);
    try {
      const res = await fetchAdminAbsoluteResponse(
        `/api/admin/security/token-export/${encodeURIComponent(userId)}`,
      );
      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      const blob     = await res.blob();
      const url      = URL.createObjectURL(blob);
      const dateStr  = new Date().toISOString().slice(0, 10);
      const filename = `session-history-${userId.slice(0, 8)}-${dateStr}.csv`;

      const a    = document.createElement("a");
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({ title: "Export ready", description: `${filename} downloaded.` });
    } catch (err: unknown) {
      toast({
        title:       "Export failed",
        description: (err as Error).message ?? "Could not download CSV",
        variant:     "destructive",
      });
    } finally {
      setCsvLoading(false);
    }
  };

  const fetchTimeline = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAdminAbsolute(`/api/admin/security/token-timeline/${encodeURIComponent(userId)}`)
      .then((data: UserTimeline) => { setTimeline(data); setLoading(false); })
      .catch((err: unknown) => { setError((err as Error).message ?? "Failed to load"); setLoading(false); });
  }, [userId]);

  useEffect(() => { fetchTimeline(); }, [fetchTimeline]);

  const executeForceLogout = async () => {
    setFlState("loading");
    try {
      const resp = await fetchAdminAbsolute(
        `/api/admin/security/force-logout/${encodeURIComponent(userId)}`,
        { method: "POST" },
      );
      setFlRevokedCount(resp.revokedCount ?? 0);
      setFlState("done");
      toast({
        title: "Sessions revoked",
        description: resp.message ?? `${resp.revokedCount} session(s) terminated.`,
      });
      /* Re-fetch timeline so stats + chain reflect the revocations */
      fetchTimeline();
    } catch (err: unknown) {
      setFlState("idle");
      toast({
        title: "Force logout failed",
        description: (err as Error).message ?? "An error occurred",
        variant: "destructive",
      });
    }
  };

  /* Close on Escape key */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const formatDate = (iso: string | null) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("en-GB", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return iso; }
  };

  const formatShort = (iso: string | null) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("en-GB", {
        day: "2-digit", month: "short",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return iso; }
  };

  const statusMeta: Record<string, { label: string; dot: string; textCls: string; icon: React.ElementType }> = {
    active:   { label: "Active",   dot: "bg-emerald-400",  textCls: "text-emerald-700",  icon: Wifi },
    rotation: { label: "Rotated",  dot: "bg-blue-400",     textCls: "text-blue-700",     icon: RotateCcw },
    breach:   { label: "Breach",   dot: "bg-red-500",      textCls: "text-red-700",      icon: AlertTriangle },
    reuse:    { label: "Reuse",    dot: "bg-orange-400",   textCls: "text-orange-700",   icon: AlertTriangle },
    security: { label: "Security", dot: "bg-amber-400",    textCls: "text-amber-700",    icon: ShieldCheck },
    expired:  { label: "Expired",  dot: "bg-gray-300",     textCls: "text-gray-500",     icon: Clock },
    other:    { label: "Other",    dot: "bg-slate-300",    textCls: "text-slate-600",    icon: KeyRound },
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed top-0 right-0 h-full w-full max-w-xl bg-white z-50 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-border bg-gradient-to-r from-rose-50 to-white flex-shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Activity className="w-4 h-4 text-rose-600 flex-shrink-0" />
              <h2 className="text-sm font-bold text-gray-900">Session Timeline</h2>
            </div>
            {timeline ? (
              <>
                <p className="text-sm font-mono text-gray-700 truncate">
                  {timeline.userPhone ?? userLabel}
                  {timeline.userName && (
                    <span className="ml-1.5 font-sans text-gray-500 font-normal text-xs">({timeline.userName})</span>
                  )}
                </p>
                <p className="text-[10px] font-mono text-gray-400 mt-0.5 truncate">{userId}</p>
              </>
            ) : (
              <p className="text-sm font-mono text-gray-500 truncate">{userLabel || userId}</p>
            )}
          </div>
          <div className="flex items-center gap-1 ml-4 flex-shrink-0">
            {/* Export CSV */}
            <button
              onClick={downloadCsv}
              disabled={csvLoading || loading}
              title="Export full session history as CSV"
              className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {csvLoading
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Download className="w-4 h-4" />
              }
            </button>
            {/* Close */}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Summary stats strip */}
        {timeline && (
          <div className="grid grid-cols-4 divide-x divide-border border-b border-border flex-shrink-0">
            {[
              { label: "Total tokens",    value: timeline.totalTokens, cls: "text-gray-700" },
              { label: "Active now",      value: timeline.activeCount,  cls: timeline.activeCount > 0 ? "text-emerald-600" : "text-gray-400" },
              { label: "Families",        value: timeline.familyCount,  cls: "text-blue-600" },
              { label: "Breach events",   value: timeline.breachCount,  cls: timeline.breachCount > 0 ? "text-red-600 font-bold" : "text-gray-400" },
            ].map(s => (
              <div key={s.label} className="flex flex-col items-center justify-center py-3 px-2 text-center">
                <span className={`text-lg font-bold ${s.cls}`}>{s.value}</span>
                <span className="text-[10px] text-gray-400 mt-0.5 leading-tight">{s.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <div className="flex items-center justify-center py-24 text-gray-400 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Loading session timeline…</span>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-24 text-red-400 gap-3">
              <XCircle className="w-8 h-8 opacity-60" />
              <p className="text-sm text-center">{error}</p>
              <Button size="sm" variant="outline" onClick={() => {
                setError(null); setLoading(true);
                fetchAdminAbsolute(`/api/admin/security/token-timeline/${encodeURIComponent(userId)}`)
                  .then((data: UserTimeline) => { setTimeline(data); setLoading(false); })
                  .catch((err: unknown) => { setError((err as Error).message); setLoading(false); });
              }}>
                Retry
              </Button>
            </div>
          )}

          {timeline && !loading && (
            <div className="space-y-6">
              {timeline.families.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-3">
                  <Users className="w-8 h-8 opacity-40" />
                  <p className="text-sm">No token records found for this user.</p>
                </div>
              )}

              {timeline.families.map((family, fi) => {
                const hasBreach = family.tokens.some(t => t.status === "breach" || t.status === "reuse");
                return (
                  <div
                    key={family.familyId ?? `no-family-${fi}`}
                    className={`rounded-2xl border overflow-hidden ${hasBreach ? "border-red-200 bg-red-50/30" : "border-border bg-white"}`}
                  >
                    {/* Family header */}
                    <div className={`px-4 py-3 border-b flex items-center gap-2 ${hasBreach ? "border-red-200 bg-red-100/40" : "border-border bg-gray-50/60"}`}>
                      {hasBreach
                        ? <AlertTriangle className="w-3.5 h-3.5 text-red-600 flex-shrink-0" />
                        : <Shield className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-bold text-gray-700">
                            {family.familyId ? `Family ${String(fi + 1).padStart(2, "0")}` : "Legacy (no family)"}
                          </span>
                          {hasBreach && (
                            <Badge className="bg-red-100 text-red-700 hover:bg-red-100 text-[10px]">
                              Breach detected
                            </Badge>
                          )}
                          <span className="text-[10px] text-gray-400 ml-auto whitespace-nowrap">
                            Started {formatDate(family.startedAt)}
                          </span>
                        </div>
                        {family.familyId && (
                          <div className="text-[10px] font-mono text-gray-400 mt-0.5 truncate" title={family.familyId}>
                            {family.familyId}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Badge className="bg-gray-100 text-gray-600 hover:bg-gray-100 text-[10px]">
                          {family.tokens.length} token{family.tokens.length !== 1 ? "s" : ""}
                        </Badge>

                        {/* Surgical revoke — only for families with active tokens */}
                        {family.familyId && family.tokens.some(t => t.status === "active") && (() => {
                          const fid   = family.familyId!;
                          const fst   = familyRevoke[fid] ?? "idle";

                          if (fst === "loading") return (
                            <span className="flex items-center gap-1 text-[10px] text-orange-600">
                              <Loader2 className="w-3 h-3 animate-spin" />
                            </span>
                          );

                          if (fst === "confirming") return (
                            <span className="flex items-center gap-1">
                              <button
                                onClick={() => revokeFamily(fid)}
                                className="text-[10px] font-semibold text-white bg-orange-500 hover:bg-orange-600 px-2 py-0.5 rounded-full transition-colors"
                              >
                                Confirm?
                              </button>
                              <button
                                onClick={() => setFamState(fid, "idle")}
                                className="text-[10px] text-gray-400 hover:text-gray-600 px-1"
                              >
                                ✕
                              </button>
                            </span>
                          );

                          return (
                            <button
                              onClick={() => setFamState(fid, "confirming")}
                              className="text-[10px] font-medium text-orange-600 border border-orange-200 bg-orange-50 hover:bg-orange-100 hover:border-orange-300 px-2 py-0.5 rounded-full transition-colors"
                            >
                              Revoke
                            </button>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Token chain */}
                    <div className="px-4 py-3 space-y-0">
                      {family.tokens.map((tok, ti) => {
                        const sm = statusMeta[tok.status] ?? statusMeta["other"]!;
                        const TokIcon = sm.icon;
                        const isLast = ti === family.tokens.length - 1;
                        const isBreach = tok.status === "breach" || tok.status === "reuse";

                        return (
                          <div key={tok.id} className="flex gap-3 group">
                            {/* Timeline spine */}
                            <div className="flex flex-col items-center flex-shrink-0">
                              <div className={`w-2.5 h-2.5 rounded-full mt-3.5 ring-2 ring-white ${sm.dot} ${isBreach ? "ring-red-200 animate-pulse" : ""}`} />
                              {!isLast && <div className={`w-0.5 flex-1 mt-1 mb-0 min-h-[20px] ${hasBreach && !isLast ? "bg-red-200" : "bg-gray-200"}`} />}
                            </div>

                            {/* Token detail */}
                            <div className={`flex-1 py-2.5 min-w-0 ${!isLast ? "border-b border-dashed border-gray-100" : ""}`}>
                              <div className="flex items-start justify-between gap-2 flex-wrap">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className={`inline-flex items-center gap-1 text-[10px] font-semibold ${sm.textCls}`}>
                                    <TokIcon className="w-3 h-3 flex-shrink-0" />
                                    {sm.label}
                                  </span>
                                  {tok.authMethod && (
                                    <span className="text-[10px] text-gray-500 capitalize bg-gray-100 px-1.5 py-0.5 rounded-full">
                                      {tok.authMethod.replace(/_/g, " ")}
                                    </span>
                                  )}
                                </div>
                                <span className="text-[10px] text-gray-400 whitespace-nowrap">
                                  {formatShort(tok.issuedAt)}
                                </span>
                              </div>

                              {tok.revokedReason && (
                                <div className={`text-[10px] font-mono mt-0.5 ${isBreach ? "text-red-500 font-semibold" : "text-gray-400"}`}>
                                  {tok.revokedReason}
                                </div>
                              )}

                              <div className="flex gap-3 mt-1 flex-wrap">
                                {tok.usedAt && (
                                  <span className="text-[10px] text-gray-400">
                                    Used: {formatShort(tok.usedAt)}
                                  </span>
                                )}
                                {tok.revokedAt ? (
                                  <span className={`text-[10px] ${isBreach ? "text-red-500 font-medium" : "text-gray-400"}`}>
                                    Revoked: {formatShort(tok.revokedAt)}
                                  </span>
                                ) : (
                                  <span className="text-[10px] text-gray-400">
                                    Expires: {formatShort(tok.expiresAt)}
                                  </span>
                                )}
                              </div>

                              <div className="text-[10px] font-mono text-gray-300 mt-0.5 truncate" title={tok.id}>
                                {tok.id}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer — Force Logout action */}
        <div className="px-6 py-4 border-t border-border bg-gray-50/60 flex-shrink-0 space-y-3">

          {/* idle: show button only if there are active sessions */}
          {flState === "idle" && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] text-gray-400 leading-relaxed">
                Each block is one login session. Tokens chain downward as sessions are refreshed.
              </p>
              {timeline && timeline.activeCount > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50 hover:border-red-300 whitespace-nowrap flex-shrink-0"
                  onClick={() => setFlState("confirming")}
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Force Logout
                </Button>
              )}
            </div>
          )}

          {/* confirming: two-step confirmation */}
          {flState === "confirming" && (
            <div className="rounded-xl border border-red-200 bg-red-50/70 p-4 space-y-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-bold text-red-800">Confirm force logout</p>
                  <p className="text-[11px] text-red-700 mt-0.5 leading-relaxed">
                    This will immediately revoke all{" "}
                    <strong>{timeline?.activeCount} active session(s)</strong> for this user. They
                    will be signed out on every device and must log in again.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-8 text-xs"
                  onClick={() => setFlState("idle")}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 h-8 text-xs bg-red-600 hover:bg-red-700 text-white gap-1.5"
                  onClick={executeForceLogout}
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Yes, Force Logout
                </Button>
              </div>
            </div>
          )}

          {/* loading: revocation in progress */}
          {flState === "loading" && (
            <div className="flex items-center justify-center gap-2 py-2 text-red-600">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-xs font-medium">Revoking sessions…</span>
            </div>
          )}

          {/* done: success state */}
          {flState === "done" && (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-emerald-700">
                <CheckCircle className="w-4 h-4 flex-shrink-0" />
                <p className="text-xs font-medium">
                  {flRevokedCount} session{flRevokedCount !== 1 ? "s" : ""} revoked. User must re-authenticate.
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-gray-500 hover:text-gray-700 flex-shrink-0"
                onClick={() => setFlState("idle")}
              >
                Dismiss
              </Button>
            </div>
          )}

        </div>
      </div>
    </>
  );
}
