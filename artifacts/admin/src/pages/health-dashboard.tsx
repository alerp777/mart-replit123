import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity, RefreshCw, Server, Satellite, ShieldCheck,
  ToggleLeft, ToggleRight, AlertTriangle, CheckCircle2,
  Info, Cpu, Clock,
  Navigation, Eye, EyeOff, MessageSquare, Zap,
  Bell, BellOff, Mail, Slack,
  Lock, LockOpen, UserX, Shield, Timer, Loader2,
  Gauge, Database, HardDrive, MemoryStick,
} from "lucide-react";
import { PageHeader } from "@/components/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useHealthDashboard, useUnlockAdminIpLockout } from "@/hooks/use-admin";
import { LastUpdated } from "@/components/ui/LastUpdated";
import { Link } from "wouter";

/* ── helpers ── */
function updatedAgo(ts: string | undefined): string {
  if (!ts) return "";
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  return `${m}m ago`;
}

/* ── sub-components ── */
function StatusDot({ ok, warning }: { ok: boolean; warning?: boolean }) {
  const color = ok ? "bg-emerald-500" : warning ? "bg-amber-500" : "bg-red-500";
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${color} ${ok ? "" : "animate-pulse"}`} />
  );
}

function Pill({ on }: { on: boolean }) {
  return on ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-xs font-medium">
      <ToggleRight size={12} /> ON
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 text-xs font-medium">
      <ToggleLeft size={12} /> OFF
    </span>
  );
}

function IssueRow({ level, message }: { level: "error" | "warning" | "info"; message: string }) {
  const cfg = {
    error:   { icon: AlertTriangle,  bg: "bg-red-500/10 border-red-500/30",   text: "text-red-400",   label: "Error" },
    warning: { icon: AlertTriangle,  bg: "bg-amber-500/10 border-amber-500/30", text: "text-amber-400", label: "Warning" },
    info:    { icon: Info,           bg: "bg-blue-500/10 border-blue-500/30",  text: "text-blue-400",  label: "Info" },
  }[level];
  const Icon = cfg.icon;
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${cfg.bg}`}>
      <Icon size={16} className={`${cfg.text} mt-0.5 shrink-0`} />
      <p className="text-sm text-slate-300 leading-snug">{message}</p>
    </div>
  );
}

function Section({ title, icon: Icon, children }: {
  title: string; icon: React.ElementType; children: React.ReactNode;
}) {
  return (
    <Card className="bg-slate-800/60 border-slate-700/50">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Icon size={16} className="text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">{title}</h2>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function StatRow({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-slate-700/40 last:border-0">
      <div>
        <span className="text-sm text-slate-400">{label}</span>
        {hint && <p className="text-xs text-slate-600 mt-0.5">{hint}</p>}
      </div>
      <div className="text-sm font-medium text-slate-200">{value}</div>
    </div>
  );
}

const FEATURE_META: Record<string, { label: string; defaultOn: boolean }> = {
  mart:         { label: "Mart / Shopping",      defaultOn: true },
  food:         { label: "Food Delivery",         defaultOn: true },
  rides:        { label: "Ride Hailing",          defaultOn: true },
  pharmacy:     { label: "Pharmacy",              defaultOn: true },
  parcel:       { label: "Parcel Delivery",       defaultOn: true },
  van:          { label: "Van / Inter-city",      defaultOn: true },
  wallet:       { label: "Wallet",                defaultOn: true },
  referral:     { label: "Referral Program",      defaultOn: true },
  newUsers:     { label: "New Registrations",     defaultOn: true },
  chat:         { label: "In-app Chat",           defaultOn: false },
  liveTracking: { label: "Live GPS Tracking",     defaultOn: true },
  reviews:      { label: "Reviews & Ratings",     defaultOn: true },
  sos:          { label: "SOS Alerts",            defaultOn: true },
  weather:      { label: "Weather Widget",        defaultOn: true },
};

/* ── skeleton ── */
function SkeletonBlock({ className = "" }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden bg-slate-700/40 rounded-lg ${className}`}>
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
    </div>
  );
}

/* ── alert channel status badge ── */
function ChannelBadge({ configured, label }: { configured: boolean; label: string }) {
  return configured ? (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 text-xs font-medium">
      <CheckCircle2 size={11} /> {label} connected
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-700/60 text-slate-500 text-xs font-medium border border-slate-600/40">
      {label} not configured
    </span>
  );
}

/* ── main page ── */
export default function HealthDashboard() {
  const qc = useQueryClient();
  const { data: raw, isLoading, isFetching, dataUpdatedAt } = useHealthDashboard();

  const handleRefresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["admin-health-dashboard"] });
  }, [qc]);

  const d = raw as any;
  const hasIssues = d?.issues?.length > 0;
  const errorCount = (d?.issues ?? []).filter((i: any) => i.level === "error").length;
  const warnCount = (d?.issues ?? []).filter((i: any) => i.level === "warning").length;
  const alertCfg = d?.alertConfig;

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        title="Health Dashboard"
        description="Real-time status of GPS tracking, content moderation rules, and service feature flags"
        icon={Activity}
      >
        <div className="flex items-center gap-3">
          <LastUpdated dataUpdatedAt={dataUpdatedAt} onRefresh={handleRefresh} isRefreshing={isFetching} />
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isFetching}
            className="gap-2 border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </PageHeader>

      {/* Issues banner */}
      {!isLoading && hasIssues && (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4 space-y-2">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={16} className="text-red-400" />
            <span className="text-sm font-semibold text-red-300">
              {errorCount > 0 ? `${errorCount} error${errorCount > 1 ? "s" : ""}` : ""}
              {errorCount > 0 && warnCount > 0 ? " · " : ""}
              {warnCount > 0 ? `${warnCount} warning${warnCount > 1 ? "s" : ""}` : ""}
              {" "}detected — review below
            </span>
          </div>
          {d.issues.map((issue: any, idx: number) => (
            <IssueRow key={idx} level={issue.level} message={issue.message} />
          ))}
        </div>
      )}

      {!isLoading && !hasIssues && d && (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 flex items-center gap-2">
          <CheckCircle2 size={16} className="text-emerald-400" />
          <span className="text-sm text-emerald-300 font-medium">All systems healthy — no issues detected</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ── Server Health ── */}
        <Section title="Server" icon={Server}>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => <SkeletonBlock key={i} className="h-9" />)}
            </div>
          ) : (
            <div>
              <StatRow
                label="Status"
                value={
                  <span className="flex items-center gap-2">
                    <StatusDot ok={true} />
                    <span className="text-emerald-400">Running</span>
                  </span>
                }
              />
              <StatRow
                label="Database"
                value={
                  <span className="flex items-center gap-2">
                    <StatusDot ok={d?.server?.db === "ok"} />
                    <span className={d?.server?.db === "ok" ? "text-emerald-400" : "text-red-400"}>
                      {d?.server?.db === "ok" ? "Connected" : "Error"}
                    </span>
                  </span>
                }
              />
              <StatRow
                label="Uptime"
                value={
                  <span className="flex items-center gap-1.5">
                    <Clock size={13} className="text-slate-500" />
                    {d?.server?.uptimeFormatted ?? "—"}
                  </span>
                }
              />
              <StatRow
                label="Memory usage"
                value={
                  <span className="flex items-center gap-1.5">
                    <Cpu size={13} className="text-slate-500" />
                    {d?.server?.memoryMb != null ? `${d.server.memoryMb} MB` : "—"}
                  </span>
                }
              />
              <StatRow label="Node.js" value={d?.server?.nodeVersion ?? "—"} />
            </div>
          )}
        </Section>

        {/* ── GPS Tracking ── */}
        <Section title="GPS Tracking" icon={Satellite}>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => <SkeletonBlock key={i} className="h-9" />)}
            </div>
          ) : (
            <div>
              <StatRow
                label="Live tracking feature"
                value={<Pill on={d?.gps?.liveTrackingEnabled ?? true} />}
              />
              <StatRow
                label="Riders in live table"
                value={
                  <span className="flex items-center gap-1.5">
                    <Navigation size={13} className="text-slate-500" />
                    {d?.gps?.ridersInLiveTable ?? 0}
                  </span>
                }
                hint="Riders currently marked online"
              />
              <StatRow
                label="Active pings (last 5 min)"
                value={
                  <span className={`flex items-center gap-2`}>
                    <StatusDot
                      ok={(d?.gps?.ridersWithRecentPing ?? 0) >= (d?.gps?.ridersInLiveTable ?? 0) || d?.gps?.ridersInLiveTable === 0}
                      warning={(d?.gps?.staleRiders ?? 0) > 0}
                    />
                    {d?.gps?.ridersWithRecentPing ?? 0}
                    {(d?.gps?.staleRiders ?? 0) > 0 && (
                      <span className="text-xs text-amber-400">({d.gps.staleRiders} stale)</span>
                    )}
                  </span>
                }
              />
              <StatRow
                label="GPS spoof detection"
                value={<Pill on={d?.gps?.spoofDetectionEnabled ?? true} />}
              />
              <StatRow
                label="Max allowed speed"
                value={`${d?.gps?.maxSpeedKmh ?? 150} km/h`}
                hint="Pings exceeding this trigger spoof alert"
              />
            </div>
          )}
          {!isLoading && (
            <div className="mt-3 pt-3 border-t border-slate-700/40">
              <Link href="/live-riders-map">
                <Button variant="ghost" size="sm" className="text-xs text-slate-400 hover:text-slate-200 px-0">
                  Open live riders map →
                </Button>
              </Link>
            </div>
          )}
        </Section>

        {/* ── Content Moderation ── */}
        <Section title="Content Moderation" icon={ShieldCheck}>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => <SkeletonBlock key={i} className="h-9" />)}
            </div>
          ) : (
            <div>
              <StatRow
                label="Custom regex patterns"
                value={
                  <span className="flex items-center gap-2">
                    {d?.moderation?.customPatternsCount > 0 || !d?.moderation?.customPatternsValid === false ? (
                      <StatusDot ok={d?.moderation?.customPatternsValid !== false} />
                    ) : null}
                    {d?.moderation?.customPatternsCount ?? 0} loaded
                    {d?.moderation?.customPatternsValid === false && (
                      <Badge variant="destructive" className="text-xs">Malformed JSON</Badge>
                    )}
                  </span>
                }
                hint="Admin-configured regex rules for chat/messages"
              />
              <StatRow
                label="Flag keywords"
                value={
                  <span className="flex items-center gap-1.5">
                    <MessageSquare size={13} className="text-slate-500" />
                    {d?.moderation?.flagKeywordsCount ?? 0} words
                  </span>
                }
              />
              <StatRow label="Mask phone numbers" value={
                <span className="flex items-center gap-1.5">
                  {d?.moderation?.hidePhone ? <Eye size={13} className="text-emerald-500" /> : <EyeOff size={13} className="text-red-500" />}
                  <Pill on={d?.moderation?.hidePhone ?? true} />
                </span>
              } />
              <StatRow label="Mask email addresses" value={<Pill on={d?.moderation?.hideEmail ?? true} />} />
              <StatRow label="Mask CNIC numbers" value={<Pill on={d?.moderation?.hideCnic ?? true} />} />
              <StatRow label="Mask bank accounts" value={<Pill on={d?.moderation?.hideBank ?? true} />} />
              <StatRow label="Mask addresses" value={<Pill on={d?.moderation?.hideAddress ?? false} />} />
            </div>
          )}
          {!isLoading && (
            <div className="mt-3 pt-3 border-t border-slate-700/40">
              <Link href="/settings/moderation">
                <Button variant="ghost" size="sm" className="text-xs text-slate-400 hover:text-slate-200 px-0">
                  Edit moderation settings →
                </Button>
              </Link>
            </div>
          )}
        </Section>

        {/* ── Feature Flags ── */}
        <Section title="Service Feature Flags" icon={Zap}>
          {isLoading ? (
            <div className="grid grid-cols-2 gap-2">
              {[...Array(14)].map((_, i) => <SkeletonBlock key={i} className="h-10" />)}
            </div>
          ) : (
            <>
              {d?.maintenanceMode && (
                <div className="mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center gap-2">
                  <AlertTriangle size={13} className="text-amber-400 shrink-0" />
                  <span className="text-xs text-amber-300">Maintenance mode is active — app is inaccessible to customers</span>
                </div>
              )}
              <div className="grid grid-cols-1 gap-0">
                {Object.entries(d?.features ?? {}).map(([key, enabled]) => {
                  const meta = FEATURE_META[key] ?? { label: key, defaultOn: true };
                  const isOn = enabled as boolean;
                  const isUnexpectedlyOff = meta.defaultOn && !isOn;
                  return (
                    <div
                      key={key}
                      className={`flex items-center justify-between py-2 px-0 border-b border-slate-700/30 last:border-0 ${isUnexpectedlyOff ? "opacity-80" : ""}`}
                    >
                      <span className={`text-sm ${isOn ? "text-slate-300" : "text-slate-500"}`}>
                        {meta.label}
                      </span>
                      <Pill on={isOn} />
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 pt-3 border-t border-slate-700/40">
                <Link href="/app-management">
                  <Button variant="ghost" size="sm" className="text-xs text-slate-400 hover:text-slate-200 px-0">
                    Manage feature flags →
                  </Button>
                </Link>
              </div>
            </>
          )}
        </Section>
      </div>

      {/* ── Performance Metrics ── */}
      <PerformanceSection data={d} isLoading={isLoading} />

      {/* ── Alert Notifications ── */}
      <Section title="Alert Notifications" icon={Bell}>
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => <SkeletonBlock key={i} className="h-9" />)}
          </div>
        ) : (
          <>
            {/* Monitor on/off banner */}
            {alertCfg && !alertCfg.monitorEnabled && (
              <div className="mb-4 px-4 py-3 rounded-xl border border-slate-600/40 bg-slate-700/30 flex items-start gap-3">
                <BellOff size={16} className="text-slate-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-slate-300 font-medium">Health monitor is disabled</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Enable it in Admin Settings → <code className="bg-slate-700 px-1 py-0.5 rounded text-slate-400">health_monitor_enabled = on</code> to start receiving alerts automatically.
                  </p>
                </div>
              </div>
            )}

            {alertCfg?.monitorEnabled && (
              <div className="mb-4 px-4 py-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 flex items-center gap-3">
                <Bell size={16} className="text-emerald-400 shrink-0" />
                <div>
                  <p className="text-sm text-emerald-300 font-medium">Health monitor is active</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Checks every {alertCfg?.intervalMin ?? 5} min · Re-alerts after {alertCfg?.snoozeMin ?? 60} min snooze
                  </p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Email channel */}
              <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Mail size={15} className="text-slate-400" />
                  <span className="text-sm font-medium text-slate-300">Email Alerts</span>
                </div>
                <div className="space-y-2">
                  <ChannelBadge configured={alertCfg?.emailConfigured ?? false} label="Email" />
                  {alertCfg?.emailConfigured && alertCfg?.alertEmail && (
                    <p className="text-xs text-slate-500 truncate" title={alertCfg.alertEmail}>
                      → {alertCfg.alertEmail}
                    </p>
                  )}
                  {!alertCfg?.emailConfigured && (
                    <p className="text-xs text-slate-600 leading-relaxed mt-1">
                      Set <code className="bg-slate-700 px-1 rounded text-slate-400">integration_email=on</code> and <code className="bg-slate-700 px-1 rounded text-slate-400">smtp_admin_alert_email</code> in Settings to enable.
                    </p>
                  )}
                </div>
              </div>

              {/* Slack channel */}
              <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Slack size={15} className="text-slate-400" />
                  <span className="text-sm font-medium text-slate-300">Slack Alerts</span>
                </div>
                <div className="space-y-2">
                  <ChannelBadge configured={alertCfg?.slackConfigured ?? false} label="Slack" />
                  {!alertCfg?.slackConfigured && (
                    <p className="text-xs text-slate-600 leading-relaxed mt-1">
                      Set <code className="bg-slate-700 px-1 rounded text-slate-400">health_alert_slack_webhook</code> to an incoming webhook URL in Settings to enable.
                    </p>
                  )}
                  {alertCfg?.slackConfigured && (
                    <p className="text-xs text-slate-500 mt-1">Incoming webhook configured</p>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-slate-700/40 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-xs text-slate-500">
                Alerts fire for <strong className="text-slate-400">critical errors</strong> only (DB down, malformed moderation config). Warnings are shown on this dashboard but don't trigger notifications.
              </p>
              <Link href="/settings">
                <Button variant="outline" size="sm" className="border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700 whitespace-nowrap text-xs">
                  Configure in Settings →
                </Button>
              </Link>
            </div>
          </>
        )}
      </Section>

      {/* ── Login Security & Lockout Monitor ── */}
      <LoginSecuritySection data={d} isLoading={isLoading} />

      {/* auto-refresh notice */}
      <p className="text-center text-xs text-slate-600">
        Auto-refreshes every 10 seconds · Last updated {dataUpdatedAt > 0 ? updatedAgo(new Date(dataUpdatedAt).toISOString()) : "—"}
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Performance Metrics sub-component
───────────────────────────────────────────────────────────────────────────── */
function PerfMetricBar({ value, threshold, label, unit = "%" }: {
  value: number | null;
  threshold: number;
  label: string;
  unit?: string;
}) {
  if (value === null) {
    return (
      <div className="flex items-center justify-between py-2.5 border-b border-slate-700/40 last:border-0">
        <span className="text-sm text-slate-400">{label}</span>
        <span className="text-xs text-slate-600 italic">No data yet</span>
      </div>
    );
  }

  const pct = unit === "%" ? value : Math.min(100, (value / threshold) * 100);
  const color =
    value >= threshold ? "bg-red-500" :
    value >= threshold * 0.8 ? "bg-amber-500" :
    "bg-emerald-500";
  const textColor =
    value >= threshold ? "text-red-400" :
    value >= threshold * 0.8 ? "text-amber-400" :
    "text-emerald-400";
  const statusIcon =
    value >= threshold ? "🔴" :
    value >= threshold * 0.8 ? "🟡" :
    "🟢";

  return (
    <div className="py-2.5 border-b border-slate-700/40 last:border-0">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm text-slate-400">{label}</span>
        <span className={`text-sm font-medium ${textColor} flex items-center gap-1.5`}>
          <span className="text-xs">{statusIcon}</span>
          {value}{unit}
          <span className="text-xs text-slate-600 font-normal">/ {threshold}{unit} limit</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-700/60 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

function PerformanceSection({ data: d, isLoading }: { data: any; isLoading: boolean }) {
  const perf = d?.performance;

  const p50Ms          = perf?.p50Ms          ?? null;
  const p95Ms          = perf?.p95Ms          ?? null;
  const p99Ms          = perf?.p99Ms          ?? null;
  const dbLatencyMs    = perf?.dbLatencyMs    ?? null;
  const dbQueryMs      = perf?.dbQueryMs      ?? null;
  const redisCacheHitRate = perf?.redisCacheHitRate ?? null;
  const queueDepth     = perf?.queueDepth     ?? 0;
  const memoryPct      = perf?.memoryPct      ?? null;
  const diskPct        = perf?.diskPct        ?? null;
  const diskFreeGb     = perf?.diskFreeGb     ?? null;

  const thresholds = perf?.thresholds ?? { p95Ms: 500, dbMs: 1000, memoryPct: 80, diskPct: 80 };

  const alertCount = [
    p95Ms !== null && p95Ms >= thresholds.p95Ms,
    dbQueryMs !== null && dbQueryMs >= thresholds.dbMs,
    memoryPct !== null && memoryPct >= thresholds.memoryPct,
    diskPct !== null && diskPct >= thresholds.diskPct,
  ].filter(Boolean).length;

  return (
    <Section title="Performance" icon={Gauge}>
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => <SkeletonBlock key={i} className="h-12" />)}
        </div>
      ) : (
        <div>
          {alertCount > 0 && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-2">
              <AlertTriangle size={13} className="text-red-400 shrink-0" />
              <span className="text-xs text-red-300">
                {alertCount} metric{alertCount > 1 ? "s" : ""} exceeding alert threshold{alertCount > 1 ? "s" : ""}
              </span>
            </div>
          )}

          {/* ── API Percentiles ── */}
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-3">
              <Gauge size={13} className="text-slate-500" />
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">API Response Percentiles</span>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-2">
              {[
                { label: "p50 (median)", value: p50Ms },
                { label: "p95", value: p95Ms, threshold: thresholds.p95Ms },
                { label: "p99 (tail)", value: p99Ms },
              ].map(({ label, value, threshold }) => {
                const isAlert = threshold != null && value != null && value >= threshold;
                const isWarning = threshold != null && value != null && value >= threshold * 0.8 && value < threshold;
                const color = isAlert ? "text-red-400" : isWarning ? "text-amber-400" : "text-emerald-400";
                return (
                  <div key={label} className={`rounded-lg border p-2 text-center ${isAlert ? "border-red-500/30 bg-red-500/5" : isWarning ? "border-amber-500/30 bg-amber-500/5" : "border-slate-700/50 bg-slate-800/40"}`}>
                    <p className={`text-base font-bold font-mono ${value == null ? "text-slate-600" : color}`}>
                      {value != null ? `${value}ms` : "—"}
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">{label}</p>
                    {threshold != null && value != null && (
                      <p className="text-[9px] text-slate-700">limit {threshold}ms</p>
                    )}
                  </div>
                );
              })}
            </div>
            {p95Ms === null && (
              <p className="text-xs text-slate-600">Collecting samples — requires at least 10 API requests</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {/* DB ping latency */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Database size={13} className="text-slate-500" />
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">DB Latency (SELECT 1)</span>
              </div>
              <PerfMetricBar
                value={dbLatencyMs}
                threshold={50}
                label="Ping latency"
                unit="ms"
              />
            </div>

            {/* DB query latency */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Database size={13} className="text-slate-500" />
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">DB Query Latency</span>
              </div>
              <PerfMetricBar
                value={dbQueryMs}
                threshold={thresholds.dbMs}
                label="Full query latency"
                unit="ms"
              />
            </div>

            {/* Redis cache hit rate */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Zap size={13} className="text-slate-500" />
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Redis Cache Hit Rate</span>
              </div>
              {redisCacheHitRate === null ? (
                <div className="flex items-center justify-between py-2.5 border-b border-slate-700/40">
                  <span className="text-sm text-slate-400">Hit rate</span>
                  <span className="text-xs text-slate-600 italic">Redis not connected</span>
                </div>
              ) : (
                <PerfMetricBar
                  value={100 - redisCacheHitRate}
                  threshold={30}
                  label={`${redisCacheHitRate}% cache hit rate`}
                  unit="%"
                />
              )}
            </div>

            {/* Queue depth */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Activity size={13} className="text-slate-500" />
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Active Connections</span>
              </div>
              <div className="flex items-center justify-between py-2.5 border-b border-slate-700/40">
                <span className="text-sm text-slate-400">Socket.IO clients</span>
                <span className={`text-sm font-medium font-mono ${queueDepth > 500 ? "text-amber-400" : "text-slate-200"}`}>
                  {queueDepth}
                </span>
              </div>
            </div>

            {/* Memory usage */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <MemoryStick size={13} className="text-slate-500" />
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Heap Memory</span>
              </div>
              <PerfMetricBar
                value={memoryPct}
                threshold={thresholds.memoryPct}
                label="Heap used"
                unit="%"
              />
            </div>

            {/* Disk usage */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <HardDrive size={13} className="text-slate-500" />
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Disk Usage</span>
              </div>
              <PerfMetricBar
                value={diskPct}
                threshold={thresholds.diskPct}
                label="Disk used"
                unit="%"
              />
              {diskFreeGb !== null && (
                <p className="text-xs text-slate-600 mt-1">{diskFreeGb} GB free</p>
              )}
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-slate-700/40">
            <p className="text-xs text-slate-600">
              Thresholds: p95 &lt; {thresholds.p95Ms}ms · DB &lt; {thresholds.dbMs}ms · Memory &lt; {thresholds.memoryPct}% · Disk &lt; {thresholds.diskPct}%
              {" · "}
              <span className="text-slate-700">Configure via Admin Settings → <code className="bg-slate-800 px-1 rounded">perf_alert_*</code> keys</span>
            </p>
          </div>
        </div>
      )}
    </Section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Login Security sub-component (extracted to keep the main component readable)
───────────────────────────────────────────────────────────────────────────── */
function LoginSecuritySection({ data: d, isLoading }: { data: any; isLoading: boolean }) {
  const unlock = useUnlockAdminIpLockout();
  const [unlocking, setUnlocking] = useState<string | null>(null);

  const lockouts: any[] = d?.authLockouts?.adminIpLockouts ?? [];
  const attempts: any[] = d?.authLockouts?.adminIpAttemptsInProgress ?? [];
  const accountLockouts: any[] = d?.authLockouts?.accountLockouts ?? [];
  const cfg = d?.authLockouts?.config ?? { maxAttempts: 5, lockoutMinutes: 15 };

  const totalThreats = lockouts.length + accountLockouts.length;
  const hasWarning = lockouts.length > 0 || accountLockouts.length > 5;

  async function handleUnlock(key: string) {
    setUnlocking(key);
    try {
      await unlock.mutateAsync(key);
    } finally {
      setUnlocking(null);
    }
  }

  return (
    <Section title="Login Security" icon={Shield}>
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <SkeletonBlock key={i} className="h-9" />)}
        </div>
      ) : (
        <div className="space-y-5">
          {/* ── Summary row ── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SummaryTile
              icon={Lock}
              label="Locked IPs"
              value={lockouts.length}
              alert={lockouts.length > 0}
            />
            <SummaryTile
              icon={Timer}
              label="IPs with failures"
              value={attempts.length}
              alert={attempts.length > 0}
              warning
            />
            <SummaryTile
              icon={UserX}
              label="Account lockouts"
              value={accountLockouts.length}
              alert={accountLockouts.length > 5}
              warning={accountLockouts.length > 0 && accountLockouts.length <= 5}
            />
            <SummaryTile
              icon={ShieldCheck}
              label="Max attempts"
              value={`${cfg.maxAttempts} / ${cfg.lockoutMinutes}m`}
              alert={false}
            />
          </div>

          {/* ── All-clear state ── */}
          {!hasWarning && lockouts.length === 0 && accountLockouts.length === 0 && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
              <LockOpen size={14} className="text-emerald-400 shrink-0" />
              <span className="text-sm text-emerald-300">No active lockouts — login attempts look normal</span>
            </div>
          )}

          {/* ── Admin IP lockouts ── */}
          {lockouts.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Lock size={13} className="text-red-400" />
                <span className="text-xs font-semibold text-red-400 uppercase tracking-wide">
                  Locked Admin IPs ({lockouts.length})
                </span>
              </div>
              <div className="rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden divide-y divide-red-500/10">
                {lockouts.map((item: any) => (
                  <div key={item.key} className="flex items-center justify-between px-4 py-3 gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-mono text-slate-200 truncate">{item.key}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {item.attempts} failed attempt{item.attempts !== 1 ? "s" : ""}
                        {" · "}locked since {new Date(item.lockedSince).toLocaleTimeString()}
                        {" · "}
                        <span className="text-red-400 font-medium">{item.minutesLeft}m remaining</span>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={unlocking === item.key}
                      onClick={() => handleUnlock(item.key)}
                      className="shrink-0 border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:text-red-200 text-xs gap-1.5"
                    >
                      {unlocking === item.key ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <LockOpen size={12} />
                      )}
                      Unlock
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── IPs with ongoing failures (not yet locked) ── */}
          {attempts.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Timer size={13} className="text-amber-400" />
                <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">
                  IPs with Recent Failures ({attempts.length})
                </span>
              </div>
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 overflow-hidden divide-y divide-amber-500/10">
                {attempts.map((item: any) => (
                  <div key={item.key} className="flex items-center justify-between px-4 py-3 gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-mono text-slate-200 truncate">{item.key}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {item.attempts}/{cfg.maxAttempts} failed attempt{item.attempts !== 1 ? "s" : ""}
                        {" · "}last at {new Date(item.lastAttempt).toLocaleTimeString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {[...Array(cfg.maxAttempts)].map((_: any, i: number) => (
                        <span
                          key={i}
                          className={`w-2 h-2 rounded-full ${i < item.attempts ? "bg-amber-400" : "bg-slate-700"}`}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Account (phone) lockouts ── */}
          {accountLockouts.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <UserX size={13} className="text-orange-400" />
                <span className="text-xs font-semibold text-orange-400 uppercase tracking-wide">
                  Locked User Accounts ({accountLockouts.length})
                </span>
              </div>
              <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 overflow-hidden divide-y divide-orange-500/10 max-h-48 overflow-y-auto">
                {accountLockouts.slice(0, 20).map((item: any, idx: number) => (
                  <div key={idx} className="flex items-center justify-between px-4 py-2.5 gap-3">
                    <p className="text-sm font-mono text-slate-300 truncate">{item.phone}</p>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-slate-500">{item.attempts} attempts</span>
                      {item.minutesLeft > 0 && (
                        <Badge variant="outline" className="text-xs border-orange-500/40 text-orange-300 bg-orange-500/10">
                          {item.minutesLeft}m left
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
                {accountLockouts.length > 20 && (
                  <div className="px-4 py-2 text-xs text-slate-500 text-center">
                    +{accountLockouts.length - 20} more — view all in Security Dashboard
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Footer links ── */}
          <div className="pt-2 border-t border-slate-700/40 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link href="/security">
              <Button variant="ghost" size="sm" className="text-xs text-slate-400 hover:text-slate-200 px-0">
                Open Security Dashboard →
              </Button>
            </Link>
            {totalThreats > 0 && (
              <span className="text-xs text-slate-600">
                Lockout window: {cfg.lockoutMinutes} min · Threshold: {cfg.maxAttempts} attempts
              </span>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

function SummaryTile({
  icon: Icon, label, value, alert, warning,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  alert: boolean;
  warning?: boolean;
}) {
  const color = alert
    ? "text-red-400 bg-red-500/10 border-red-500/20"
    : warning
    ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
    : "text-slate-400 bg-slate-800/40 border-slate-700/40";
  return (
    <div className={`rounded-xl border p-3 ${color}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={13} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className={`text-lg font-semibold ${alert ? "text-red-300" : warning ? "text-amber-300" : "text-slate-200"}`}>
        {value}
      </p>
    </div>
  );
}
